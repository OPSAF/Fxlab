/**
 * API 冒烟测试：逐个打真实 HTTP 接口，验证返回结构与数值合理性。
 * 跑法（服务已启动的前提下）：node tests/api-smoke.mjs
 */
const BASE = process.env.FXLAB_BASE || 'http://127.0.0.1:8787';
let pass = 0;
let fail = 0;

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✔ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`  ✖ ${name}${detail ? '  ' + detail : ''}`);
  }
}

async function get(path) {
  const r = await fetch(BASE + path);
  const j = await r.json();
  if (!r.ok) throw new Error(`${path} → ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path} → ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

console.log(`\n=== fxlab API 冒烟测试 @ ${BASE} ===\n`);

const meta = await get('/api/meta');
check('meta.pairs = 16', meta.pairs.length === 16, `实际 ${meta.pairs.length}`);
check('meta.strategies ≥ 6', meta.strategies.length >= 6, `实际 ${meta.strategies.length}`);
check('meta.sources = 3', meta.sources.length === 3);

const q = await get('/api/quotes');
check('quotes 已就绪', q.quotes.length === 16, `实际 ${q.quotes.length}`);
const eurusd = q.quotes.find((x) => x.symbol === 'EURUSD');
check('EURUSD 价格量级合理 (0.5~2)', eurusd && eurusd.last > 0.5 && eurusd.last < 2, JSON.stringify({ last: eurusd?.last, bid: eurusd?.bid, ask: eurusd?.ask }));
check('点差为正', eurusd && eurusd.ask > eurusd.bid);
check('spark 走势图数据', Object.keys(q.spark || {}).length > 0);

const h = await get('/api/history?symbol=EURUSD&source=ecb&start=2015-01-01');
check('ECB 日线行数 > 2000', h.bars.length > 2000, `${h.bars.length} 行 ${h.meta.start}→${h.meta.end}`);
check('ECB 无 OHLC 标记', h.meta.hasOhlc === false);

const h2 = await get('/api/history?symbol=EURUSD&source=em');
check('东财分钟线 > 100 根', h2.bars.length > 100, `${h2.bars.length} 根`);
check('分钟线 OHLC 有序', h2.bars.every((b) => b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close)));

const h3 = await get('/api/history?symbol=USDJPY&source=sim&days=500&seed=123');
check('模拟器可复现（同 seed 同结果）', h3.bars.length === 500);

const bt = await post('/api/backtest', {
  symbol: 'EURUSD',
  source: 'ecb',
  start: '2012-01-01',
  strategyId: 'sma_cross',
  params: { fast: 10, slow: 50 },
  costs: { costPips: 1 },
  trainRatio: 0.7,
});
check('回测返回指标', Number.isFinite(bt.metrics.sharpe), `sharpe=${bt.metrics.sharpe?.toFixed(2)} 收益=${(bt.metrics.totalReturn * 100).toFixed(1)}% 回撤=${(bt.metrics.maxDD * 100).toFixed(1)}%`);
check('回测含基准对比', Number.isFinite(bt.benchmark.sharpe));
check('回测含样本内外切分', !!bt.split && Number.isFinite(bt.split.outOfSample.sharpe));
check('权益曲线长度一致', bt.series.equity.length === bt.series.dates.length);
check('回撤 ≤ 0', bt.series.drawdown.every((d) => d <= 1e-12));
check('交易明细有方向字段', bt.trades.length === 0 || bt.trades.every((t) => [1, -1].includes(t.dir)));

const grid = await post('/api/grid', {
  symbol: 'EURUSD',
  source: 'ecb',
  start: '2013-01-01',
  strategyId: 'sma_cross',
  grid: { x: { key: 'fast', min: 4, max: 12, step: 4 }, y: { key: 'slow', min: 20, max: 60, step: 20 }, fixed: {} },
  costs: { costPips: 1 },
  trainRatio: 0.7,
});
check('网格格子数正确', grid.cells.length === 3 * 3, `${grid.cells.length} 格`);
check('网格给出样本内外最优', !!grid.bestInSample && !!grid.bestOutOfSample, `IS ${grid.bestInSample.x}/${grid.bestInSample.y} 夏普 ${grid.bestInSample.sharpe} | OS ${grid.bestOutOfSample.x}/${grid.bestOutOfSample.y} 夏普 ${grid.bestOutOfSample.sharpe}`);

const st = await post('/api/stats', { symbol: 'EURUSD', source: 'ecb', start: '2015-01-01' });
const rp = st.report;
check('统计：年化波动有限', Number.isFinite(rp.ret.annVol), `年化波动 ${(rp.ret.annVol * 100).toFixed(1)}%`);
check('统计：VaR 为正数', rp.var.every((v) => v.histVar > 0));
check('统计：ACF 10 阶', rp.acf.values.length === 11);
check('统计：Hurst 在 (0,1)', rp.hurst == null || (rp.hurst > 0 && rp.hurst < 1), `H=${rp.hurst}`);
check('统计：ADF 有结论', !!rp.adf, `t=${rp.adf?.tstat} 拒绝单位根=${rp.adf?.rejectUnitRoot}`);
check('统计：直方图计数等于样本量', rp.histogram.counts.reduce((s, c) => s + c, 0) === rp.n);

const cmp = await post('/api/compare', {
  symbol: 'EURUSD',
  source: 'ecb',
  start: '2015-01-01',
  costPips: 1,
  strategies: [{ id: 'sma_cross', params: { fast: 10, slow: 50 } }, { id: 'donchian', params: { period: 20 } }, { id: 'buy_hold', params: {} }],
});
check('策略对比 3 行', cmp.rows.length === 3 && cmp.rows.every((r) => !r.error));

const cap = await post('/api/capture', { action: 'start', symbol: 'EURUSD' });
check('采集器启动', cap.capture.active === true);
await new Promise((r) => setTimeout(r, 8000));
const capNow = await get('/api/capture?frame=1m');
check('采集到 K 线', capNow.bars.length > 0, `1m 根数 ${capNow.bars.length}, ticks ${capNow.capture.ticks}`);
const capStop = await post('/api/capture', { action: 'stop' });
check('采集器停止', capStop.capture.active === false);

const exp = await post('/api/experiments', { name: '冒烟测试', strategyId: 'sma_cross', metrics: bt.metrics });
check('实验记录写入', exp.ok === true);
const expList = await get('/api/experiments');
check('实验记录可读', expList.items.length >= 1);

const health = await get('/api/health');
// 注意：日线数据有缓存，命中缓存时不会产生新的外部请求，所以健康度里可能只有 2 个源有记录
check('健康度已记录数据源', health.sources.length >= 2, health.sources.map((s) => `${s.source}:${s.failures}失败`).join(' '));

// SSE
const ctrl = new AbortController();
const sseOk = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 9000);
  fetch(BASE + '/api/stream', { signal: ctrl.signal })
    .then(async (res) => {
      const reader = res.body.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      clearTimeout(timer);
      resolve(text.includes('event: quotes'));
      ctrl.abort();
    })
    .catch(() => {
      clearTimeout(timer);
      resolve(false);
    });
});
check('SSE 推送正常', sseOk);

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);

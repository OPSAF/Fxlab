/**
 * 快照回退测试：模拟「Cloudflare 被拦、frankfurter 完全不可达」的国内网络，
 * 验证静态版依然能靠构建时生成的 web/data/ecb/*.json 正常出图、回测、统计。
 *
 * 这是这次线上问题的回归测试：浏览器报
 *   net::ERR_FAILED + No 'Access-Control-Allow-Origin' header
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAP = path.join(ROOT, 'web', 'data', 'ecb', 'EURUSD.json');

let hasSnapshot = true;
try {
  await fs.access(SNAP);
} catch {
  hasSnapshot = false;
}

if (!hasSnapshot) {
  console.log('\n⚠ 没有 web/data/ecb 快照，跳过（构建时会由 scripts/fetch-ecb.mjs 生成）\n');
  process.exit(0);
}

// 只放行同源快照；任何外网请求都当成「被墙」直接抛错
globalThis.fetch = async (url) => {
  if (typeof url === 'string' && url.startsWith('./data/')) {
    const buf = await fs.readFile(path.join(ROOT, 'web', url.slice(2)));
    return new Response(buf, { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const err = new TypeError('Failed to fetch');
  err.cause = { code: 'ERR_NETWORK' };
  throw err;
};

const { staticApi } = await import('../web/js/static-api.mjs');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  ✔ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`  ✖ ${name}${detail ? '  ' + detail : ''}`);
  }
};

console.log('\n=== 断网（模拟被墙）下的静态模式 ===\n');

const hist = await staticApi('/api/history?symbol=EURUSD&source=ecb&start=2015-01-01');
check('日线可用（来自快照）', hist.bars.length > 2000, `${hist.bars.length} 根 ${hist.meta.start} → ${hist.meta.end}`);
check('数据截止日期合理', hist.meta.end >= '2026-01-01', String(hist.meta.end));

const chart = await staticApi('/api/chart', { symbol: 'EURUSD', source: 'ecb', start: '2020-01-01', indicators: ['sma', 'rsi'] });
check('图表指标可计算', chart.overlays.length === 2 && chart.osc.length === 1, `${chart.bars.length} 根 K 线`);

const bt = await staticApi('/api/backtest', {
  symbol: 'EURUSD',
  source: 'ecb',
  start: '2015-01-01',
  strategyId: 'sma_cross',
  params: { fast: 10, slow: 50 },
  costs: { costPips: 1 },
  trainRatio: 0.7,
});
check('回测可运行', Number.isFinite(bt.metrics.sharpe), `夏普 ${bt.metrics.sharpe?.toFixed(2)}`);
check('样本内外切分可用', !!bt.split, `${bt.split?.inSample.nTrades} / ${bt.split?.outOfSample.nTrades} 笔`);

const st = await staticApi('/api/stats', { symbol: 'EURUSD', source: 'ecb', start: '2015-01-01' });
check('统计体检可运行', Number.isFinite(st.report.ret.annVol), `年化波动 ${(st.report.ret.annVol * 100).toFixed(2)}%`);

// 外汇对也要能在断网下取到（验证不是只对 EURUSD 特判）
const jpy = await staticApi('/api/history?symbol=USDJPY&source=ecb&start=2015-01-01');
check('其他货币对同样可用', jpy.bars.length > 2000, `USDJPY ${jpy.bars.length} 根`);

console.log(`\n快照回退: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);

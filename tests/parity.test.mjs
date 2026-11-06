/**
 * 对拍测试：同一组参数下，服务端算出的结果与浏览器端（static-api）必须一致。
 *
 * 为什么值得写：静态版把计算搬了一份到浏览器，最容易出的问题不是「报错」，
 * 而是「悄悄算出不一样的结果」——比如少截了一段数据、年化因子取错。
 * 这里用同一数据集跑两条路径，逐字段比对。
 */
import assert from 'node:assert/strict';
import { staticApi } from '../web/js/static-api.mjs';

const BASE = process.env.FXLAB_BASE || 'http://127.0.0.1:8787';

async function serverPost(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

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

const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a));

const btBody = {
  symbol: 'EURUSD',
  source: 'ecb',
  start: '2015-01-01',
  strategyId: 'sma_cross',
  params: { fast: 10, slow: 50 },
  costs: { costPips: 1 },
  trainRatio: 0.7,
};

console.log('\n=== 服务端 vs 浏览器端 对拍 ===\n');

const [srv, loc] = await Promise.all([serverPost('/api/backtest', btBody), staticApi('/api/backtest', btBody)]);
check('数据行数一致', srv.meta.rows === loc.meta.rows, `${srv.meta.rows} vs ${loc.meta.rows}`);
check('总收益一致', near(srv.metrics.totalReturn, loc.metrics.totalReturn), `${srv.metrics.totalReturn} vs ${loc.metrics.totalReturn}`);
check('夏普一致', near(srv.metrics.sharpe, loc.metrics.sharpe, 1e-6), `${srv.metrics.sharpe?.toFixed(6)} vs ${loc.metrics.sharpe?.toFixed(6)}`);
check('最大回撤一致', near(srv.metrics.maxDD, loc.metrics.maxDD), `${srv.metrics.maxDD} vs ${loc.metrics.maxDD}`);
check('交易笔数一致', srv.metrics.nTrades === loc.metrics.nTrades, `${srv.metrics.nTrades} vs ${loc.metrics.nTrades}`);
check('样本外夏普一致', near(srv.split.outOfSample.sharpe, loc.split.outOfSample.sharpe, 1e-6));
check('权益曲线终值一致', near(srv.series.equity.at(-1), loc.series.equity.at(-1)));

const stBody = { symbol: 'EURUSD', source: 'ecb', start: '2015-01-01' };
const [sStats, lStats] = await Promise.all([serverPost('/api/stats', stBody), staticApi('/api/stats', stBody)]);
check('年化波动一致', near(sStats.report.ret.annVol, lStats.report.ret.annVol, 1e-9), `${(sStats.report.ret.annVol * 100).toFixed(4)}%`);
check('Hurst 一致', sStats.report.hurst === lStats.report.hurst, String(sStats.report.hurst));
check('VaR(99%) 一致', near(sStats.report.var[1].histVar, lStats.report.var[1].histVar));

const chartBody = { symbol: 'EURUSD', source: 'ecb', start: '2020-01-01', indicators: ['sma', 'rsi', 'boll'] };
const [sChart, lChart] = await Promise.all([serverPost('/api/chart', chartBody), staticApi('/api/chart', chartBody)]);
check('图表 K 线数一致', sChart.bars.length === lChart.bars.length, `${sChart.bars.length}`);
check('指标线数量一致', sChart.overlays.length === lChart.overlays.length, `${sChart.overlays.length} 条`);

const quotes = await staticApi('/api/quotes');
check('静态模式能取到实时报价', quotes.quotes.length >= 15, `${quotes.quotes.length} 个货币对`);
check('报价含买卖价', quotes.quotes.every((q) => q.bid > 0 && q.ask > 0));

console.log(`\n对拍结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);

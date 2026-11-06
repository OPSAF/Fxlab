/**
 * 量化内核单元测试。
 * 跑法：node --test tests/
 *
 * 原则：测试里用的都是能手算验证的小例子，而不是「跑通就算过」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, bollinger, atr, donchian } from '../server/core/indicators.mjs';
import { runBacktest, evaluate, gridSearch } from '../server/core/backtest.mjs';
import { logReturns, ols, quantile, mean, stddev } from '../server/core/mathx.mjs';
import { BarAggregator, resample } from '../server/core/bar-aggregator.mjs';
import { analyze, hurst, halfLife } from '../server/core/stats.mjs';
import { simulateDaily } from '../server/providers/simulator.mjs';

const mkBars = (prices) => prices.map((c, i) => ({ date: `2024-01-${String(i + 1).padStart(2, '0')}`, open: c, high: c, low: c, close: c }));

test('SMA：手算核对 + 前置 null', () => {
  const out = sma([1, 2, 3, 4, 5], 3);
  assert.deepEqual(out.slice(0, 2), [null, null]);
  assert.equal(out[2], 2); // (1+2+3)/3
  assert.equal(out[4], 4); // (3+4+5)/3
});

test('EMA：种子为前 n 个的 SMA，后续按 α=2/(n+1)', () => {
  const out = ema([1, 2, 3, 4, 5], 3);
  assert.equal(out[0], null);
  assert.equal(out[2], 2); // 种子 (1+2+3)/3
  assert.ok(Math.abs(out[3] - (4 * 0.5 + 2 * 0.5)) < 1e-12);
});

test('RSI：单调上涨时趋近 100', () => {
  const prices = Array.from({ length: 40 }, (_, i) => 100 + i);
  const r = rsi(prices, 14);
  assert.equal(r[10], null);
  assert.equal(r[39], 100);
});

test('RSI：已知序列的数值核对', () => {
  // 标准 Wilder 例：涨 14 天后 RSI 应为 100；全跌应为 0
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.equal(rsi(down, 14)[20], 0);
});

test('布林带：σ 用总体标准差，上下轨对称', () => {
  const v = [1, 2, 3, 4, 5];
  const b = bollinger(v, 5, 2);
  const m = 3;
  const sd = Math.sqrt(2); // 总体标准差
  assert.ok(Math.abs(b.mid[4] - m) < 1e-12);
  assert.ok(Math.abs(b.upper[4] - (m + 2 * sd)) < 1e-12);
  assert.ok(Math.abs(b.lower[4] - (m - 2 * sd)) < 1e-12);
});

test('ATR：第 n 根起有值，且非负', () => {
  const bars = mkBars([1, 1.1, 1.2, 1.15, 1.3, 1.25, 1.4, 1.35, 1.5, 1.45, 1.6, 1.55, 1.7, 1.65, 1.8, 1.75]);
  const a = atr(bars, 5);
  assert.equal(a[3], null);
  assert.ok(a[4] > 0);
});

test('唐奇安通道：上轨严格使用「不含当根」的过去 n 根', () => {
  const bars = mkBars([1, 5, 2, 2, 9]);
  const { upper } = donchian(bars, 2);
  // bars[4] 的通道 = max(bars[2].high, bars[3].high) = 2，当前这根 9 不能算进去（否则就是未来函数）
  assert.equal(upper[4], 2);
  assert.equal(upper[2], 5); // bar0..bar1 的最高
});

test('对数收益：r = ln(Pt/Pt-1)', () => {
  const r = logReturns([100, 110]);
  assert.ok(Math.abs(r[1] - Math.log(1.1)) < 1e-12);
  assert.equal(r[0], null);
});

test('OLS：精确恢复 y = 2 + 3x', () => {
  const X = [];
  const y = [];
  for (let x = 0; x < 20; x++) {
    X.push([1, x]);
    y.push(2 + 3 * x);
  }
  const reg = ols(X, y);
  assert.ok(Math.abs(reg.beta[0] - 2) < 1e-9);
  assert.ok(Math.abs(reg.beta[1] - 3) < 1e-9);
  assert.ok(reg.r2 > 0.999999);
});

test('分位数：线性插值', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4], 0), 1);
});

test('回测：买入持有的终值 = 价格比值（零成本）', () => {
  const bars = mkBars([1, 1.1, 1.21, 1.331]);
  const pos = new Array(bars.length).fill(1);
  const res = runBacktest(bars, pos, { costPips: 0 });
  assert.ok(Math.abs(res.equity.at(-1) - 1.331) < 1e-9);
  assert.ok(Math.abs(res.metrics.totalReturn - 0.331) < 1e-9);
});

test('回测：成本 = 换手 × 点差/价格', () => {
  const bars = mkBars([1, 1, 1, 1]);
  const pos = [0, 1, 1, 0]; // 第1根买入，第3根卖出
  const res = runBacktest(bars, pos, { costPips: 2, pip: 0.01 });
  // 两次换手，每次 2*0.01/1 = 2%
  assert.ok(Math.abs(res.equity.at(-1) - 0.98 * 0.98) < 1e-9);
});

test('回测：无未来函数——信号在 i 只吃 i→i+1 的收益', () => {
  const bars = mkBars([1, 2, 1, 1]);
  // 只有第 0 根持仓 → 吃到 1→2 的 +100%
  const res = runBacktest(bars, [1, 0, 0, 0], { costPips: 0 });
  assert.ok(Math.abs(res.equity[1] - 2) < 1e-9);
  assert.ok(Math.abs(res.equity.at(-1) - 2) < 1e-9, '后续空仓不应再赚');
});

test('回测指标：单调上涨时最大回撤为 0、夏普为正', () => {
  const bars = mkBars(Array.from({ length: 300 }, (_, i) => 1 + i * 0.001));
  const res = runBacktest(bars, new Array(300).fill(1), { costPips: 0 });
  assert.equal(res.metrics.maxDD, 0);
  assert.ok(res.metrics.sharpe > 0);
});

test('策略评估：SMA 交叉能产出信号与指标线', () => {
  const bars = simulateDaily('EURUSD', { days: 800, seed: 42 });
  const res = evaluate({ bars, strategyId: 'sma_cross', params: { fast: 5, slow: 20 }, costs: { costPips: 1, pip: 0.0001 } });
  assert.ok(res.positions.some((p) => p !== 0));
  assert.equal(res.overlays.length, 2);
  assert.ok(res.metrics.nTrades >= 0);
  assert.equal(res.series.equity.length, bars.length);
});

test('网格搜索：返回 IS/OS 两套结果与分割点', () => {
  const bars = simulateDaily('EURUSD', { days: 600, seed: 7 });
  const g = gridSearch({
    bars,
    strategyId: 'sma_cross',
    grid: { x: { key: 'fast', min: 3, max: 12, step: 3 }, y: { key: 'slow', min: 20, max: 60, step: 10 }, fixed: {} },
    costs: { costPips: 1, pip: 0.0001 },
  });
  assert.equal(g.cells.length, g.xs.length * g.ys.length);
  assert.ok(g.splitIndex > 0 && g.splitIndex < bars.length);
  assert.ok(g.bestInSample.sharpe !== undefined);
});

test('聚合器：同一桶内先到的是 open、最新的是 close', () => {
  const agg = new BarAggregator('EURUSD', ['5s', '1m']);
  const t0 = 1_700_000_000_000;
  agg.push(1.1, t0);
  agg.push(1.2, t0 + 1000);
  agg.push(1.05, t0 + 2000);
  const s = agg.series('1m');
  assert.equal(s.length, 1);
  assert.equal(s[0].open, 1.1);
  assert.equal(s[0].high, 1.2);
  assert.equal(s[0].low, 1.05);
  assert.equal(s[0].close, 1.05);
  assert.equal(s[0].n, 3);
});

test('聚合器：跨桶自动收盘', () => {
  const agg = new BarAggregator('EURUSD', ['5s'], { onClose: (f, b) => closed.push(b) });
  const closed = [];
  const t0 = 1_700_000_000_000;
  agg.push(1.1, t0);
  agg.push(1.2, t0 + 10_000); // 已跨过两个 5s 桶
  assert.equal(closed.length, 1);
  assert.equal(closed[0].close, 1.1);
});

test('重采样：1m → 5m 的 OHLC 正确', () => {
  const bars = Array.from({ length: 10 }, (_, i) => ({
    t: new Date(Date.UTC(2024, 0, 1, 0, i)).toISOString(),
    open: i + 1,
    high: i + 2,
    low: i,
    close: i + 1.5,
  }));
  const out = resample(bars, 5);
  assert.equal(out.length, 2);
  assert.equal(out[0].open, 1);
  assert.equal(out[0].high, 6);
  assert.equal(out[0].low, 0);
  assert.equal(out[0].close, 5.5);
});

test('统计：Hurst 在随机游走附近约为 0.5', () => {
  const bars = simulateDaily('EURUSD', { days: 3000, seed: 99 });
  const rets = logReturns(bars.map((b) => b.close)).filter((x) => x != null);
  const h = hurst(rets);
  assert.ok(h > 0.3 && h < 0.7, `H ≈ 0.5，实际 ${h}`);
});

test('统计：分析报告字段齐全且数值有限', () => {
  const bars = simulateDaily('EURUSD', { days: 1200, seed: 5 });
  const a = analyze(bars);
  assert.ok(a.n > 1000);
  assert.ok(Number.isFinite(a.ret.annVol));
  assert.equal(a.var.length, 2);
  assert.ok(a.histogram.counts.reduce((s, c) => s + c, 0) === a.n);
  assert.ok(Number.isFinite(a.ret.kurt));
});

test('半衰期：均值回归序列的半衰期短于随机游走', () => {
  const mr = [];
  let v = 0;
  let prev = 0;
  for (let i = 0; i < 400; i++) {
    v = -0.6 * prev + (Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.01;
    mr.push(v);
    prev = v;
  }
  const rw = simulateDaily('EURUSD', { days: 400, seed: 11 }).map((b) => Math.log(b.close));
  const a = halfLife(mr);
  const b = halfLife(rw);
  assert.ok(a.halfLife !== null);
  assert.ok(b.halfLife === null || b.halfLife > a.halfLife);
});

test('mean/stddev 基础自检', () => {
  assert.equal(mean([1, 2, 3]), 2);
  assert.ok(Math.abs(stddev([1, 2, 3]) - 1) < 1e-12);
});

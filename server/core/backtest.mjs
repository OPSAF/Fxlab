/**
 * 回测引擎。
 *
 * 关键约定（写死在代码里，前端也照此解释）：
 *  1. 信号在第 i 根 K 线收盘时确定 → 从第 i 根收盘后开始持有 → 吃第 i→i+1 的收益。
 *     因此 positions[i] 只能吃到 ret[i+1]，**永远不会**吃到本根 K 线的收益。
 *  2. 成本按「换手」收取：cost = |pos_i - pos_{i-1}| × 点差点数 × pip / 价格。
 *     点差默认 1 pip，等于把「买卖价差」当成了必须付出的摩擦。
 *  3. 权益按简单收益连乘，等价于「每期把全部本金押上去」，不涉及杠杆和资金管理。
 *
 * 任何一条改了，回测数字都会变——这正是为什么策略对比必须固定同样的约定。
 */
import { mean, stddev, quantile } from './mathx.mjs';
import { getStrategy, resolveParams } from './strategies.mjs';

/**
 * @param {Array<{date?:string,t?:string,open?:number,high?:number,low?:number,close:number}>} bars
 * @param {Array<number>} positions 目标仓位（与 bars 等长）
 * @param {object} opts { costPips, pip, annualBars, riskFree }
 */
export function runBacktest(bars, positions, { costPips = 1, pip = 0.0001, annualBars = 252, riskFree = 0 } = {}) {
  const n = bars.length;
  if (n < 3) throw new Error('回测至少需要 3 根 K 线');

  const equity = new Array(n).fill(1);
  const gross = new Array(n).fill(1); // 不计成本，用来看「成本吃掉了多少」
  const rets = new Array(n).fill(0); // 净收益（每根）
  const posSeries = new Array(n).fill(0);
  const trades = [];
  const costs = [];

  let openTrade = null;

  for (let i = 1; i < n; i++) {
    const r = bars[i].close / bars[i - 1].close - 1;
    const costRate = (costPips * pip) / bars[i].close;
    const p = positions[i - 1] ?? 0; // 用上一根收盘时的目标仓位，吃本根收益
    const turnover = Math.abs((positions[i] ?? p) - p);
    const cost = turnover * costRate;

    rets[i] = p * r - cost;
    costs[i] = cost;
    posSeries[i] = p;

    // 交易记录
    const newPos = positions[i] ?? p;
    if (newPos !== p) {
      if (p !== 0 && openTrade) {
        openTrade.exitIdx = i;
        openTrade.exitDate = bars[i].date ?? bars[i].t;
        openTrade.exitPrice = bars[i].close;
        openTrade.ret = (openTrade.dir * (openTrade.exitPrice / openTrade.entryPrice - 1)) - (2 * costRate);
        openTrade.bars = i - openTrade.entryIdx;
        trades.push(openTrade);
        openTrade = null;
      }
      if (newPos !== 0) {
        openTrade = {
          dir: Math.sign(newPos),
          entryIdx: i,
          entryDate: bars[i].date ?? bars[i].t,
          entryPrice: bars[i].close,
          exitIdx: null,
          exitPrice: null,
          ret: null,
          bars: null,
        };
      }
    }
  }

  // 未平仓的交易按最后一根收盘价平掉
  if (openTrade) {
    openTrade.exitIdx = n - 1;
    openTrade.exitDate = bars[n - 1].date ?? bars[n - 1].t;
    openTrade.exitPrice = bars[n - 1].close;
    openTrade.ret = openTrade.dir * (openTrade.exitPrice / openTrade.entryPrice - 1);
    openTrade.bars = n - 1 - openTrade.entryIdx;
    openTrade.open = true;
    trades.push(openTrade);
  }

  // 逐期累积权益曲线（净 / 毛利两条）
  let e2 = 1;
  let g2 = 1;
  for (let i = 1; i < n; i++) {
    e2 *= 1 + rets[i];
    g2 *= 1 + rets[i] + (costs[i] || 0);
    equity[i] = e2;
    gross[i] = g2;
  }

  const drawdown = maxDrawdownSeries(equity);
  const metrics = summarize({ equity, rets, trades, positions: posSeries, costs, annualBars, riskFree, bars });
  const benchPositions = new Array(n).fill(1);
  const bench = runSimple(bars, benchPositions, { costPips: 0, pip, annualBars });

  return {
    equity,
    gross,
    drawdown,
    rets,
    positions: posSeries,
    trades: trades.slice(-500),
    metrics,
    benchmark: bench.metrics,
    series: {
      dates: bars.map((b) => b.date ?? b.t),
      close: bars.map((b) => b.close),
      equity,
      drawdown,
    },
  };
}

/** 基准：只在最后算指标，不生成交易明细 */
function runSimple(bars, positions, { costPips = 1, pip = 0.0001, annualBars = 252 }) {
  const eq = [1];
  const rets = [0];
  let e = 1;
  for (let i = 1; i < bars.length; i++) {
    const r = bars[i].close / bars[i - 1].close - 1;
    const p = positions[i - 1] ?? 0;
    const cost = (costPips * pip) / bars[i].close;
    e *= 1 + p * r - cost;
    eq.push(e);
    rets.push(p * r - cost);
  }
  return { metrics: summarize({ equity: eq, rets, trades: [], positions, costs: [], annualBars, riskFree: 0, bars }) };
}

function maxDrawdownSeries(equity) {
  const out = new Array(equity.length).fill(0);
  let peak = equity[0] ?? 1;
  for (let i = 0; i < equity.length; i++) {
    peak = Math.max(peak, equity[i]);
    out[i] = equity[i] / peak - 1;
  }
  return out;
}

function summarize({ equity, rets, trades, positions, costs, annualBars, riskFree, bars }) {
  const n = equity.length;
  const total = equity[n - 1] - 1;
  const years = Math.max(1e-9, (n - 1) / annualBars);
  const cagr = n > 1 && equity[n - 1] > 0 ? Math.pow(equity[n - 1], 1 / years) - 1 : -1;

  const r = rets.slice(1).filter((x) => Number.isFinite(x));
  const annVol = stddev(r) * Math.sqrt(annualBars);
  const annRet = mean(r) * annualBars;
  const sharpe = annVol > 0 ? (annRet - riskFree) / annVol : 0;

  const downside = r.filter((x) => x < 0);
  const dd = downside.length ? Math.sqrt(downside.reduce((s, x) => s + x * x, 0) / r.length) : 0;
  const sortino = dd > 0 ? (annRet - riskFree) / (dd * Math.sqrt(annualBars)) : 0;

  const ddSeries = maxDrawdownSeries(equity);
  const maxDD = Math.min(...ddSeries, 0);
  const calmar = maxDD < 0 ? cagr / -maxDD : 0;

  const closed = trades;
  const wins = closed.filter((t) => t.ret > 0);
  const losses = closed.filter((t) => t.ret <= 0);
  const gain = wins.reduce((s, t) => s + t.ret, 0);
  const loss = -losses.reduce((s, t) => s + t.ret, 0);
  const exposure = positions.filter((p) => p !== 0).length / n;
  const totalCost = costs.reduce((s, x) => s + (x || 0), 0);
  const totalRet = r.reduce((s, x) => s + x, 0);

  const peak = Math.max(...equity);
  const retSorted = [...r].sort((a, b) => a - b);

  return {
    bars: n,
    years: +years.toFixed(2),
    totalReturn: total,
    cagr,
    annVol,
    annRet,
    sharpe,
    sortino,
    maxDD,
    calmar,
    winRate: closed.length ? wins.length / closed.length : 0,
    profitFactor: loss > 0 ? gain / loss : gain > 0 ? Infinity : 0,
    nTrades: closed.length,
    avgTradeRet: closed.length ? mean(closed.map((t) => t.ret)) : 0,
    avgHoldBars: closed.length ? mean(closed.map((t) => t.bars ?? 0)) : 0,
    exposure,
    totalCost,
    costDrag: totalRet !== 0 ? totalCost / Math.max(1e-9, Math.abs(totalRet) + totalCost) : 0,
    bestBar: retSorted.length ? retSorted[retSorted.length - 1] : 0,
    worstBar: retSorted.length ? retSorted[0] : 0,
    finalEquity: equity[n - 1],
    peakEquity: peak,
    // 分布信息——比单一夏普更能看清收益来源
    p5: quantile(retSorted, 0.05),
    medianBar: quantile(retSorted, 0.5),
  };
}

/**
 * 策略完整评估：构建信号 + 回测 + 返回可绘制的一切。
 */
export function evaluate({ bars, strategyId, params = {}, costs = {} }) {
  const strategy = getStrategy(strategyId);
  const p = resolveParams(strategyId, params);
  const built = strategy.build(bars, p);
  const pip = costs.pip ?? 0.0001;
  const res = runBacktest(bars, built.positions, {
    costPips: costs.costPips ?? 1,
    pip,
    annualBars: costs.annualBars ?? 252,
  });
  return {
    strategyId,
    params: p,
    overlays: built.overlays,
    positions: built.positions,
    ...res,
  };
}

/**
 * 参数网格搜索 + 样本内外切分。
 *
 * 教学目的：让「过拟合」变得肉眼可见——
 * 样本内夏普最高的参数格子，往往在样本外并不突出。
 */
export function gridSearch({ bars, strategyId, grid, costs = {}, trainRatio = 0.7, metric = 'sharpe' }) {
  const strategy = getStrategy(strategyId);
  const split = Math.max(30, Math.floor(bars.length * trainRatio));
  const isBars = bars.slice(0, split);
  const osBars = bars.slice(split);
  if (osBars.length < 20) throw new Error('样本外区间太短，请扩大时间范围');

  const xKey = grid.x.key;
  const yKey = grid.y.key;
  const xs = range(grid.x.min, grid.x.max, grid.x.step);
  const ys = range(grid.y.min, grid.y.max, grid.y.step);
  if (xs.length * ys.length > 1600) throw new Error('网格太大（>1600 格），请减小步长范围');

  const cells = [];
  for (const y of ys) {
    for (const x of xs) {
      const params = { ...grid.fixed, [xKey]: x, [yKey]: y };
      try {
        const p = resolveParams(strategyId, params);
        const built = strategy.build(bars, p); // 一次构建全样本信号，避免重复计算
        const isRes = runBacktest(isBars, built.positions.slice(0, split), { ...costs });
        const osRes = runBacktest(osBars, built.positions.slice(split), { ...costs });
        cells.push({
          x,
          y,
          is: pickMetrics(isRes.metrics),
          os: pickMetrics(osRes.metrics),
        });
      } catch {
        cells.push({ x, y, is: null, os: null });
      }
    }
  }

  const valid = cells.filter((c) => c.is);
  const best = valid.reduce((a, b) => (b.is[metric] > a.is[metric] ? b : a), valid[0]);
  const bestOs = valid.reduce((a, b) => (b.os[metric] > a.os[metric] ? b : a), valid[0]);
  const isTop = [...valid].sort((a, b) => b.is[metric] - a.is[metric]).slice(0, Math.max(1, Math.ceil(valid.length * 0.05)));
  const osTop = [...valid].sort((a, b) => b.os[metric] - a.os[metric]).slice(0, Math.max(1, Math.ceil(valid.length * 0.05)));

  return {
    strategyId,
    splitIndex: split,
    splitDate: bars[split]?.date ?? bars[split]?.t ?? null,
    x: grid.x,
    y: grid.y,
    xs,
    ys,
    cells,
    bestInSample: { x: best.x, y: best.y, ...best.is, osScore: best.os[metric] },
    bestOutOfSample: { x: bestOs.x, y: bestOs.y, ...bestOs.os },
    rankCorr: spearmanTopBand(isTop, osTop),
    metric,
  };
}

function pickMetrics(m) {
  return {
    sharpe: round(m.sharpe, 3),
    totalReturn: round(m.totalReturn, 4),
    maxDD: round(m.maxDD, 4),
    nTrades: m.nTrades,
    winRate: round(m.winRate, 3),
  };
}

const round = (v, d = 3) => (Number.isFinite(v) ? +v.toFixed(d) : v);

function range(min, max, step) {
  const out = [];
  for (let v = min; v <= max + 1e-9; v += step) out.push(+v.toFixed(4));
  return out;
}

/** 粗略衡量「样本内前 5% 与样本外前 5% 的重合度」，接近 0 就说明参数完全不稳健 */
function spearmanTopBand(isTop, osTop) {
  const key = (c) => `${c.x}|${c.y}`;
  const osSet = new Set(osTop.map(key));
  const hit = isTop.filter((c) => osSet.has(key(c))).length;
  return { overlap: hit / Math.max(1, isTop.length), n: isTop.length };
}

export { maxDrawdownSeries };

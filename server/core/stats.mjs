/**
 * 统计与检验：把「这条价格序列长什么样」讲清楚。
 *
 * 这里只放**能解释、能验证**的统计量，每个都带定义与判读口径：
 *  - 年化波动率：日收益标准差 × √252
 *  - VaR / ES：历史分位数法与正态假设法并列，让你看到「假设正态会低估多少尾部」
 *  - 自相关：检验「昨天的涨跌能否预测今天」，±1.96/√n 是 95% 置信带
 *  - Hurst 指数：>0.5 趋势性、≈0.5 随机游走、<0.5 均值回归
 *  - 半衰期：AR(1) 系数推出来的「偏离均值后回到一半需要多少期」
 *  - ADF：单位根检验，原假设「存在单位根（随机游走）」
 */
import { mean, stddev, skewness, kurtosis, quantile, autocorr, ols, logReturns } from './mathx.mjs';

const normInv = (p) => {
  // Acklam 近似逆正态分布，够用且不需要依赖
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q;
  let r;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pl) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
};

export function histogram(values, bins = 40) {
  if (!values.length) return { bins: [], edges: [] };
  const sorted = [...values].sort((a, b) => a - b);
  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];
  const width = (hi - lo) / bins || 1e-9;
  const edges = Array.from({ length: bins + 1 }, (_, i) => lo + i * width);
  const counts = new Array(bins).fill(0);
  for (const v of values) {
    let idx = Math.floor((v - lo) / width);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    counts[idx] += 1;
  }
  return { edges, counts, width, lo, hi };
}

/** Hurst 指数：R/S 法的简化版（窗口 8..min(256, n/2)） */
export function hurst(series) {
  const r = series.filter((x) => Number.isFinite(x));
  const n = r.length;
  if (n < 64) return null;
  const sizes = [];
  for (let s = 8; s <= Math.min(256, Math.floor(n / 4)); s *= 2) sizes.push(s);
  const xs = [];
  const ys = [];
  for (const size of sizes) {
    const blocks = Math.floor(n / size);
    let acc = 0;
    let cnt = 0;
    for (let b = 0; b < blocks; b++) {
      const seg = r.slice(b * size, (b + 1) * size);
      const m = mean(seg);
      let cum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const v of seg) {
        cum += v - m;
        if (cum < min) min = cum;
        if (cum > max) max = cum;
      }
      const R = max - min;
      const S = stddev(seg, 0);
      if (S > 0 && R > 0) {
        acc += R / S;
        cnt += 1;
      }
    }
    if (cnt) {
      xs.push(Math.log(size));
      ys.push(Math.log(acc / cnt));
    }
  }
  if (xs.length < 3) return null;
  const X = xs.map((x) => [1, x]);
  const reg = ols(X, ys);
  return reg ? +reg.beta[1].toFixed(3) : null;
}

/** AR(1) 半衰期：Δp = α + β·p_{t-1}，half-life = -ln2 / β（仅当 β<0 时有意义） */
export function halfLife(logPrices) {
  const p = logPrices.filter((x) => Number.isFinite(x));
  if (p.length < 30) return null;
  const X = [];
  const y = [];
  for (let i = 1; i < p.length; i++) {
    X.push([1, p[i - 1]]);
    y.push(p[i] - p[i - 1]);
  }
  const reg = ols(X, y);
  if (!reg || reg.beta[1] >= 0) return { beta: reg?.beta[1] ?? null, halfLife: null };
  return {
    beta: +reg.beta[1].toFixed(6),
    tstat: +reg.tstat[1].toFixed(2),
    halfLife: +(-Math.log(2) / reg.beta[1]).toFixed(1),
  };
}

/** ADF 单位根检验（含截距、滞后 1 阶）。原假设 H0：存在单位根 = 随机游走 */
export function adf(logPrices) {
  const p = logPrices.filter((x) => Number.isFinite(x));
  if (p.length < 40) return null;
  const X = [];
  const y = [];
  for (let i = 2; i < p.length; i++) {
    X.push([1, p[i - 1], p[i - 1] - p[i - 2]]);
    y.push(p[i] - p[i - 1]);
  }
  const reg = ols(X, y);
  if (!reg) return null;
  const t = reg.tstat[1];
  // MacKinnon 近似临界值（含常数项，样本量足够大时）
  return { tstat: +t.toFixed(2), cv5: -2.86, rejectUnitRoot: t < -2.86 };
}

export function analyze(bars, { annualBars = 252, varLevels = [0.95, 0.99] } = {}) {
  const closes = bars.map((b) => b.close);
  const prices = closes;
  const rets = logReturns(prices).filter((x) => x != null && Number.isFinite(x));
  const sorted = [...rets].sort((a, b) => a - b);
  const n = rets.length;
  const m = mean(rets);
  const sd = stddev(rets);
  const annVol = sd * Math.sqrt(annualBars);
  const annRet = m * annualBars;

  const tail = (q) => sorted.slice(0, Math.max(1, Math.floor(n * (1 - q))));

  const varTable = varLevels.map((lv) => {
    const hist = -quantile(sorted, 1 - lv);
    const param = -(m + normInv(1 - lv) * sd);
    const es = -(mean(tail(lv)) || 0);
    return { level: lv, histVar: hist, paramVar: param, es, esParam: sd * normPdf(normInv(1 - lv)) / (1 - lv) - m };
  });

  const acf = Array.from({ length: 11 }, (_, k) => (k === 0 ? null : +autocorr(rets, k)?.toFixed(4)));
  const ci = 1.96 / Math.sqrt(n);

  const jb = (n / 6) * (skewness(rets) ** 2 + (kurtosis(rets) ** 2) / 4);

  return {
    n,
    start: bars[0]?.date ?? bars[0]?.t,
    end: bars.at(-1)?.date ?? bars.at(-1)?.t,
    price: { first: closes[0], last: closes.at(-1) },
    ret: { mean: m, std: sd, annRet, annVol, skew: skewness(rets), kurt: kurtosis(rets) },
    sharpeOfAsset: annVol > 0 ? annRet / annVol : 0,
    var: varTable,
    jb: { stat: jb, isNormal: jb < 5.99, note: 'JB>5.99（5% 显著性）即拒绝正态假设' },
    acf: { values: acf, ci: +ci.toFixed(4), significant: acf.filter((v) => v != null && Math.abs(v) > ci).length },
    halfLife: halfLife(prices.map((p) => Math.log(p))),
    adf: adf(prices.map((p) => Math.log(p))),
    hurst: hurst(rets),
    histogram: histogram(rets, 48),
    // 前面补一个 null：让滚动波动率的下标与原始价格序列对齐（rets 少了一期）
    rollingVol: [null, ...rollingVolSeries(rets, Math.min(60, Math.max(20, Math.floor(n / 10))), annualBars)],
  };
}

function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function rollingVolSeries(rets, win, annualBars) {
  const out = new Array(rets.length).fill(null);
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < rets.length; i++) {
    s += rets[i];
    s2 += rets[i] * rets[i];
    if (i >= win) {
      s -= rets[i - win];
      s2 -= rets[i - win] * rets[i - win];
    }
    if (i >= win - 1) {
      const mm = s / win;
      const v = Math.max(0, s2 / win - mm * mm);
      out[i] = Math.sqrt(v) * Math.sqrt(annualBars);
    }
  }
  return out;
}

/** 两两相关性矩阵：组合视角的最低门槛（FX 里 EURUSD 与 GBPUSD 高度正相关） */
export function correlationMatrix(seriesBySymbol) {
  const syms = Object.keys(seriesBySymbol);
  const rets = {};
  for (const s of syms) rets[s] = logReturns(seriesBySymbol[s]).filter((x) => x != null);
  const minLen = Math.min(...syms.map((s) => rets[s].length));
  const m = syms.map((a) =>
    syms.map((b) => {
      const x = rets[a].slice(-minLen);
      const y = rets[b].slice(-minLen);
      let num = 0;
      let dx = 0;
      let dy = 0;
      const mx = mean(x);
      const my = mean(y);
      for (let i = 0; i < minLen; i++) {
        num += (x[i] - mx) * (y[i] - my);
        dx += (x[i] - mx) ** 2;
        dy += (y[i] - my) ** 2;
      }
      return dx && dy ? +(num / Math.sqrt(dx * dy)).toFixed(3) : null;
    }),
  );
  return { symbols: syms, matrix: m, n: minLen };
}

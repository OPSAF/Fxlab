/**
 * 基础数学工具：描述统计、分位数、最小二乘回归。
 * 保持零依赖，且每个函数都短到可以逐行核对——量化代码最怕「黑箱」。
 */

export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

export function variance(a, ddof = 1) {
  if (a.length <= ddof) return NaN;
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - ddof);
}

export const stddev = (a, ddof = 1) => Math.sqrt(variance(a, ddof));

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function skewness(a) {
  const n = a.length;
  if (n < 3) return NaN;
  const m = mean(a);
  const s = stddev(a, 0);
  if (!s) return 0;
  return (a.reduce((acc, x) => acc + ((x - m) / s) ** 3, 0) * n) / ((n - 1) * (n - 2));
}

export function kurtosis(a) {
  const n = a.length;
  if (n < 4) return NaN;
  const m = mean(a);
  const s = stddev(a, 0);
  if (!s) return 0;
  const g2 = a.reduce((acc, x) => acc + ((x - m) / s) ** 4, 0) / n - 3;
  // 样本无偏修正（Fisher 定义，正态分布为 0）
  return ((n - 1) * ((n + 1) * g2 + 6)) / ((n - 2) * (n - 3));
}

export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return NaN;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : NaN;
}

export function autocorr(a, lag) {
  const n = a.length - lag;
  if (n < 3) return NaN;
  return correlation(a.slice(0, n), a.slice(lag));
}

/**
 * 普通最小二乘：y = X·β + ε，X 每行已含截距列。
 * 高斯消元解正规方程 (XᵀX)β = Xᵀy，返回 β、残差标准差、t 统计量与 R²。
 */
export function ols(X, y) {
  const n = X.length;
  const k = X[0].length;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  const inv = invert(XtX);
  if (!inv) return null;
  const beta = inv.map((row) => row.reduce((s, v, j) => s + v * Xty[j], 0));

  let sse = 0;
  const ybar = mean(y);
  let sst = 0;
  for (let i = 0; i < n; i++) {
    const fit = X[i].reduce((s, v, j) => s + v * beta[j], 0);
    sse += (y[i] - fit) ** 2;
    sst += (y[i] - ybar) ** 2;
  }
  const sigma2 = n > k ? sse / (n - k) : NaN;
  const se = inv.map((row, j) => Math.sqrt(Math.max(0, sigma2 * row[j])));
  const tstat = beta.map((b, j) => (se[j] ? b / se[j] : NaN));
  return { beta, se, tstat, r2: sst ? 1 - sse / sst : NaN, sigma: Math.sqrt(sigma2), n };
}

function invert(M) {
  const k = M.length;
  const A = M.map((r, i) => [...r, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    const p = A[col][col];
    for (let j = 0; j < 2 * k; j++) A[col][j] /= p;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (!f) continue;
      for (let j = 0; j < 2 * k; j++) A[r][j] -= f * A[col][j];
    }
  }
  return A.map((r) => r.slice(k));
}

/** 对数收益率序列：r_t = ln(P_t / P_{t-1}) */
export function logReturns(prices) {
  const out = new Array(prices.length).fill(null);
  for (let i = 1; i < prices.length; i++) out[i] = Math.log(prices[i] / prices[i - 1]);
  return out;
}

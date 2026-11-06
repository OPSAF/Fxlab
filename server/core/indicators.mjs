/**
 * 技术指标。
 *
 * 工程约定（很重要）：
 *  - 每个函数返回与输入等长的数组，前面「数据不够」的位置填 null。
 *    这样指标下标与 K 线下标严格一一对应，画图和回测都不会错位。
 *  - 所有指标在第 i 个位置只使用 i 及之前的数据，天然没有未来函数（look-ahead bias）。
 *  - 窗口标准差统一用总体标准差（除以 n），与布林带原版定义一致。
 */
import { mean } from './mathx.mjs';

const empty = (n) => new Array(n).fill(null);

/** 简单移动平均 SMA_n = (1/n)·Σ P_{i-k} */
export function sma(values, n) {
  const out = empty(values.length);
  if (n < 1) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** 指数移动平均：α = 2/(n+1)，用前 n 个值的 SMA 作为种子 */
export function ema(values, n) {
  const out = empty(values.length);
  if (n < 1 || values.length < n) return out;
  const a = 2 / (n + 1);
  let seed = 0;
  for (let i = 0; i < n; i++) seed += values[i];
  seed /= n;
  out[n - 1] = seed;
  for (let i = n; i < values.length; i++) out[i] = values[i] * a + out[i - 1] * (1 - a);
  return out;
}

/** 相对强弱指标 RSI（Wilder 平滑版）：RSI = 100 - 100/(1+RS)，RS = 平均涨幅/平均跌幅 */
export function rsi(values, n = 14) {
  const out = empty(values.length);
  if (values.length <= n) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= n;
  avgLoss /= n;
  out[n] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (n - 1) + g) / n;
    avgLoss = (avgLoss * (n - 1) + l) / n;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/** 真实波幅 True Range = max(H-L, |H-C_prev|, |L-C_prev|) */
export function trueRange(bars) {
  const out = empty(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const h = b.high ?? b.close;
    const l = b.low ?? b.close;
    if (i === 0) {
      out[i] = h - l;
      continue;
    }
    const pc = bars[i - 1].close;
    out[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return out;
}

/** 平均真实波幅 ATR（Wilder 平滑）—— 用「波动幅度」而不是「收益率标准差」衡量风险 */
export function atr(bars, n = 14) {
  const tr = trueRange(bars);
  const out = empty(bars.length);
  if (bars.length <= n) return out;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += tr[i];
  out[n - 1] = sum / n;
  for (let i = n; i < bars.length; i++) out[i] = (out[i - 1] * (n - 1) + tr[i]) / n;
  return out;
}

/** 滚动标准差（总体，除以 n） */
export function rollingStd(values, n) {
  const out = empty(values.length);
  for (let i = n - 1; i < values.length; i++) {
    let s = 0;
    let s2 = 0;
    for (let j = i - n + 1; j <= i; j++) {
      s += values[j];
      s2 += values[j] * values[j];
    }
    const m = s / n;
    out[i] = Math.sqrt(Math.max(0, s2 / n - m * m));
  }
  return out;
}

/** 布林带：中轨 SMA_n，上下轨 = 中轨 ± k·σ_n */
export function bollinger(values, n = 20, k = 2) {
  const mid = sma(values, n);
  const sd = rollingStd(values, n);
  const upper = empty(values.length);
  const lower = empty(values.length);
  for (let i = 0; i < values.length; i++) {
    if (mid[i] == null) continue;
    upper[i] = mid[i] + k * sd[i];
    lower[i] = mid[i] - k * sd[i];
  }
  return { mid, upper, lower, width: upper.map((u, i) => (u == null ? null : (u - lower[i]) / mid[i])) };
}

/** 滚动对数收益的 z 分数：(r_t - μ) / σ，判断「这次波动有多异常」 */
export function rollingZ(values, n = 60) {
  const out = empty(values.length);
  const m = sma(values, n);
  const s = rollingStd(values, n);
  for (let i = 0; i < values.length; i++) if (m[i] != null && s[i] > 0) out[i] = (values[i] - m[i]) / s[i];
  return out;
}

/** 滚动年化波动率（收益为日频时 ann = 252） */
export function rollingVol(returns, n = 20, ann = 252) {
  const sd = rollingStd(returns, n);
  return sd.map((x) => (x == null ? null : x * Math.sqrt(ann)));
}

/** 唐奇安通道：过去 n 根（不含当根）的最高/最低 */
export function donchian(bars, n = 20) {
  const upper = empty(bars.length);
  const lower = empty(bars.length);
  for (let i = n; i < bars.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - n; j < i; j++) {
      const h = bars[j].high ?? bars[j].close;
      const l = bars[j].low ?? bars[j].close;
      if (h > hi) hi = h;
      if (l < lo) lo = l;
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

/** 便捷：取出某个指标里非 null 部分的最小/最大值（画坐标轴用） */
export function extent(...arrays) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const a of arrays) {
    for (const v of a) {
      if (v == null || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return { min: lo, max: hi };
}

export { mean };

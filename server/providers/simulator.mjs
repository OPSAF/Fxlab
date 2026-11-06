/**
 * 模拟器：几何布朗运动（Geometric Brownian Motion, GBM）
 *
 * 为什么要有它？
 *  1. 周末外汇休市（周五 22:00 到周一凌晨），没有实时数据时实验室不能停摆；
 *  2. 教学上，你知道「真实参数」的时候，才能检验策略是抓到了信号还是在拟合噪声；
 *  3. 用来演示「同样的策略在随机游走上看起来也能赚钱」——这是最有效的过拟合警钟。
 *
 * 模型：dS/S = μ dt + σ dW，离散化后为
 *   S_{t+1} = S_t · exp((μ - σ²/2)·dt + σ·√dt·Z)
 *
 * 参数按货币对给出年化波动率量级（EURUSD ≈ 8%，USDJPY ≈ 10%，新兴市场更高）。
 * 用 seed 保证可复现：同一个 seed 永远生成同一条路径。
 */
import { pairMap } from '../config.mjs';

const ANNUAL_VOL = {
  EURUSD: 0.08, GBPUSD: 0.09, USDJPY: 0.10, USDCHF: 0.08, AUDUSD: 0.10, USDCAD: 0.08,
  NZDUSD: 0.11, EURJPY: 0.10, GBPJPY: 0.13, EURGBP: 0.06, EURCHF: 0.05, EURAUD: 0.11,
  USDCNY: 0.04, USDHKD: 0.005, USDSGD: 0.05, USDMXN: 0.14,
};

/** 可复现的伪随机数：mulberry32 */
export function rng(seed = 20260101) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller：把均匀分布变成标准正态 */
export function gauss(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function basePrice(symbol) {
  const p = pairMap.get(symbol);
  return p ? 1 / Math.sqrt(10) * 1.12 : 1;
}

/**
 * 生成日线路径（含 OHLC）
 * @param {string} symbol
 * @param {object} o { start, days, seed, mu, vol }
 */
export function simulateDaily(symbol, { start = '2015-01-01', days = 2500, seed = 20260101, mu = 0, vol } = {}) {
  const p = pairMap.get(symbol);
  const sigma = vol ?? ANNUAL_VOL[symbol] ?? 0.09;
  const rand = rng(seed);
  const dt = 1 / 252;
  const drift = (mu - 0.5 * sigma * sigma) * dt;
  const diff = sigma * Math.sqrt(dt);

  // 起始价位：用真实量级，避免价格看起来离谱
  let price = startPrice(symbol);
  const bars = [];
  let d = new Date(start + 'T00:00:00Z');
  for (let i = 0; i < days; i++) {
    // 跳过周末，让日线节奏与真实一致（回测的年化因子才可比）
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    const open = price;
    const z = gauss(rand);
    const close = open * Math.exp(drift + diff * z);
    const wick = Math.abs(gauss(rand)) * diff * 0.7;
    const high = Math.max(open, close) * Math.exp(wick);
    const low = Math.min(open, close) * Math.exp(-wick);
    bars.push({ date: d.toISOString().slice(0, 10), open, high, low, close: close });
    price = close;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return bars;
}

function startPrice(symbol) {
  const table = {
    EURUSD: 1.08, GBPUSD: 1.27, USDJPY: 148, USDCHF: 0.88, AUDUSD: 0.66, USDCAD: 1.36,
    NZDUSD: 0.61, EURJPY: 160, GBPJPY: 188, EURGBP: 0.85, EURCHF: 0.95, EURAUD: 1.63,
    USDCNY: 7.2, USDHKD: 7.81, USDSGD: 1.34, USDMXN: 17.5,
  };
  return table[symbol] ?? basePrice(symbol);
}

/** 生成分钟级路径（用于「日内策略」教学） */
export function simulateIntraday(symbol, { day = '2026-01-05', minutes = 600, seed = 7, vol } = {}) {
  const sigma = vol ?? (ANNUAL_VOL[symbol] ?? 0.09) * 1.4; // 日内波动略高于日线年化
  const rand = rng(seed);
  const dt = 1 / (252 * 1440);
  let price = startPrice(symbol);
  const bars = [];
  const base = new Date(`${day}T06:00:00+08:00`).getTime();
  for (let i = 0; i < minutes; i++) {
    const t = new Date(base + i * 60000);
    const open = price;
    const close = open * Math.exp((sigma * Math.sqrt(dt)) * gauss(rand));
    const wick = Math.abs(gauss(rand)) * sigma * Math.sqrt(dt) * 0.6;
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    bars.push({
      t: `${day}T${hh}:${mm}:00+08:00`,
      date: day,
      open,
      close,
      high: Math.max(open, close) * Math.exp(wick),
      low: Math.min(open, close) * Math.exp(-wick),
    });
    price = close;
  }
  return bars;
}

export const annualVol = (symbol) => ANNUAL_VOL[symbol] ?? 0.09;

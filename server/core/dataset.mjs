/**
 * 数据装配层：把不同来源统一成「回测引擎能直接吃」的 bar 数组。
 *
 * 统一口径：
 *   { date, t?, open, high, low, close, n? }
 * 没有 OHLC 的数据源（ECB 日线）会把 open/high/low 填成 close，
 * 并在 meta.hasOhlc=false 上标注，前端据此决定画蜡烛还是画折线。
 */
import { fetchDaily } from '../providers/frankfurter.mjs';
import { fetchIntraday } from '../providers/eastmoney.mjs';
import { simulateDaily, simulateIntraday } from '../providers/simulator.mjs';
import { pairMap } from '../config.mjs';

export const SOURCES = [
  {
    id: 'ecb',
    name: 'ECB 日线（Frankfurter）',
    hasOhlc: false,
    annualBars: 252,
    tf: '1d',
    note: '欧央行每日参考汇率，工作日 16:00 CET 左右更新；只有收盘价，无开高低。数据可回溯到 1999 年。',
    credit: 'api.frankfurter.app',
  },
  {
    id: 'em',
    name: '东方财富分钟线（当日）',
    hasOhlc: true,
    annualBars: 252 * 1440,
    tf: '1m',
    note: '当天 06:00（北京时间）起的逐分钟 OHLC。只有「今天」，历史分钟线要靠本项目自己采集积累。',
    credit: 'push2.eastmoney.com',
  },
  {
    id: 'sim',
    name: '模拟器（GBM 随机游走）',
    hasOhlc: true,
    annualBars: 252,
    tf: '1d',
    note: '几何布朗运动生成，参数可复现。真实参数已知——用来检验「策略到底抓到了信号，还是在拟合噪声」。',
    credit: 'fxlab 内置',
  },
];

export const sourceMap = new Map(SOURCES.map((s) => [s.id, s]));

export function sourceInfo(id) {
  return sourceMap.get(id) ?? SOURCES[0];
}

/**
 * @param {object} o
 * @param {string} o.symbol 货币对
 * @param {string} o.source ecb | em | sim
 * @param {string} [o.start] 起始日期 YYYY-MM-DD
 * @param {string} [o.end]
 * @param {number} [o.days] 模拟器长度
 * @param {number} [o.seed] 模拟器种子
 */
export async function loadDataset({ symbol, source = 'ecb', start, end, days = 2500, seed = 20260101 }) {
  const meta = sourceInfo(source);
  const pair = pairMap.get(symbol);
  if (!pair) throw new Error(`未知货币对 ${symbol}`);

  if (source === 'ecb') {
    const s = start || '2010-01-01';
    const raw = await fetchDaily(symbol, { start: s, end: end || '' });
    const bars = raw.map((b) => ({ date: b.date, open: b.close, high: b.close, low: b.close, close: b.close }));
    return withMeta(symbol, source, bars, meta);
  }

  if (source === 'em') {
    const { bars, day } = await fetchIntraday(symbol);
    return withMeta(symbol, source, bars, { ...meta, day });
  }

  if (source === 'sim') {
    const bars = simulateDaily(symbol, { start: start || '2015-01-01', days: Number(days) || 2500, seed: Number(seed) || 20260101 });
    return withMeta(symbol, source, bars, { ...meta, seed: Number(seed) || 20260101 });
  }

  throw new Error(`未知数据源 ${source}`);
}

function withMeta(symbol, source, bars, meta) {
  if (!bars.length) throw new Error('数据集为空');
  return {
    symbol,
    source,
    meta: { ...meta, rows: bars.length, start: bars[0].date ?? bars[0].t, end: bars.at(-1).date ?? bars.at(-1).t },
    bars,
  };
}

/** 由模拟器生成日内数据（教学用：演示日内策略在噪声上的表现） */
export function simulatedIntraday(symbol, opts = {}) {
  return simulateIntraday(symbol, opts);
}

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
import { simulateDaily, simulateIntraday } from './simulator.mjs';
import { pairMap, SOURCES, sourceInfo } from './pairs.mjs';

// 数据源元数据只有一份，放在 pairs.mjs（浏览器端也要用同一份文案）
export { SOURCES, sourceInfo };
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

/**
 * Frankfurter —— 欧洲央行（ECB）每日参考汇率，免费、无 key、可回溯到 1999 年。
 *
 * 局限（必须在界面上写明）：
 *  1. 每个交易日只有 1 个价格（收盘/参考价），没有开高低、没有成交量和点差；
 *  2. 只在工作日发布，周末与假日的价格沿用上一个工作日；
 *  3. 时点是欧洲中部时间 16:00 左右，不是北京时间零点。
 *
 * 因此它适合「日频策略的中长期验证」，不适合做日内或高频结论。
 */
import { getJSON, TtlCache } from './http.mjs';
import { pairMap, CACHE } from '../config.mjs';
import { readJSON, writeJSON } from '../core/store.mjs';

const mem = new TtlCache(CACHE.dailyTtlMs);

function cacheKey(p) {
  return `daily-${p.from}-${p.to}`;
}

/** 抓取 [start, end] 区间的日收盘序列，返回 [{date, close}] 升序 */
export async function fetchDaily(symbol, { start = '1999-01-04', end = '' } = {}) {
  const p = pairMap.get(symbol);
  if (!p) throw new Error(`未知货币对 ${symbol}`);
  const key = cacheKey(p);

  // 1) 内存缓存命中：区间完全覆盖就直接返回
  const hit = mem.get(key);
  if (hit && hit.bars.length && hit.rangeStart <= start && hit.rangeEnd >= (end || today())) {
    return slice(hit.bars, start, end);
  }

  // 2) 磁盘缓存（进程重启后仍然有效），按「取全量」策略维护，简单可靠
  const disk = await readJSON(`${key}.json`);
  let bars = null;
  if (disk && Date.now() - Date.parse(disk.fetchedAt) < CACHE.dailyTtlMs) {
    bars = disk.bars;
  }
  if (!bars) {
    const url = `https://api.frankfurter.app/${start}..${end || ''}?from=${p.from}&to=${p.to}`;
    const j = await getJSON(url, { source: 'frankfurter', timeoutMs: 20000, retries: 2 });
    bars = Object.entries(j.rates || {})
      .map(([date, r]) => ({ date, close: Number(r[p.to]) }))
      .filter((b) => Number.isFinite(b.close) && b.close > 0)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!bars.length) throw new Error(`Frankfurter 无 ${symbol} 数据`);
    await writeJSON(`${key}.json`, { fetchedAt: new Date().toISOString(), from: p.from, to: p.to, bars });
  }
  mem.set(key, { bars, rangeStart: bars[0].date, rangeEnd: bars[bars.length - 1].date });
  return slice(bars, start, end);
}

function slice(bars, start, end) {
  const e = end || '9999-12-31';
  return bars.filter((b) => b.date >= start && b.date <= e);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** 最新一个可用交易日（用于界面提示「数据截止」） */
export async function latestDate(symbol) {
  const bars = await fetchDaily(symbol, { start: '2024-01-01' });
  return bars[bars.length - 1]?.date ?? null;
}

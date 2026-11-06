/**
 * 东方财富 —— 提供当日分钟线（trends2）与单点报价。
 *
 * trends2 返回当天 06:00 起（北京时间）的逐分钟 OHLC：
 *   { trends: ["2026-11-06 16:56,open,close,high,low,vol,amount", ...] }
 * 注意：字段顺序是 时间,开,收,高,低,量,额 —— 不是常见的 OHLC 顺序，别弄反。
 *
 * 局限：只有「当天」的分钟线，历史分钟线需要自己采集（本项目的 tick→bar 模块就是干这个的）。
 */
import { getJSON, TtlCache } from './http.mjs';
import { pairMap } from '../config.mjs';

const mem = new TtlCache(30_000);

function secidOf(symbol) {
  const p = pairMap.get(symbol);
  if (!p) throw new Error(`未知货币对 ${symbol}`);
  return p.em;
}

const HEADERS = { Referer: 'https://quote.eastmoney.com/' };

export async function fetchIntraday(symbol) {
  const secid = secidOf(symbol);
  const key = `em-${secid}`;
  const hit = mem.get(key);
  if (hit) return hit;

  const url =
    `https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}&ndays=1&iscr=0` +
    `&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57`;
  const j = await getJSON(url, { source: 'eastmoney', headers: HEADERS, timeoutMs: 12000, retries: 1 });
  const rows = j?.data?.trends;
  if (!Array.isArray(rows) || !rows.length) throw new Error(`东方财富无 ${symbol} 分钟线`);

  const bars = [];
  for (const row of rows) {
    const [ts, o, c, h, l] = row.split(',');
    const open = Number(o);
    const close = Number(c);
    const high = Number(h);
    const low = Number(l);
    if (![open, close, high, low].every(Number.isFinite)) continue;
    if (open <= 0 || close <= 0) continue;
    bars.push({ t: ts.replace(' ', 'T') + ':00+08:00', date: ts.slice(0, 10), open, high, low, close });
  }
  const value = { bars, day: bars[0]?.date ?? null, fetchedAt: new Date().toISOString() };
  mem.set(key, value);
  return value;
}

/**
 * 新浪财经实时外汇报价（hq.sinajs.cn）
 *
 * 返回的是 GBK 编码的 JS 赋值语句，形如：
 *   var hq_str_fx_seurusd="16:54:34,1.118400,1.118500,1.121800,68,1.121700,...";
 *
 * 字段下标（针对 fx_ 系列，已用多种货币对交叉验证）：
 *   0  时间 HH:MM:SS（北京时间）
 *   1  买价 bid
 *   2  卖价 ask
 *   3  昨收 prevClose
 *   4  成交量（手）
 *   5  今开 open
 *   6  最高 high
 *   7  最低 low
 *   8  最新价 last
 *   9  中文名
 *   10 涨跌幅 %
 *   11 涨跌额
 *   12 振幅 %
 *   14 52 周最高
 *   15 52 周最低
 *   17 日期 YYYY-MM-DD
 *
 * 注意：新浪必须带 Referer，否则返回 403；编码是 GBK，用 TextDecoder('gbk') 解码。
 */
import { getText } from './http.mjs';
import { PAIRS, pairMap } from '../config.mjs';

const num = (s) => {
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

export function parseSinaPayload(text) {
  const out = [];
  const re = /var hq_str_(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    const [, code, payload] = m;
    if (!payload) continue;
    const f = payload.split(',');
    const symbol = PAIRS.find((p) => p.sina === code)?.symbol || code;
    const meta = pairMap.get(symbol);
    const bid = num(f[1]);
    const ask = num(f[2]);
    const last = num(f[8]) ?? bid;
    if (last == null) continue;
    out.push({
      symbol,
      time: f[0],
      date: f[17],
      bid,
      ask,
      last,
      prevClose: num(f[3]),
      open: num(f[5]),
      high: num(f[6]),
      low: num(f[7]),
      nameZh: f[9] || meta?.zh || symbol,
      changePct: num(f[10]),
      change: num(f[11]),
      amplitudePct: num(f[12]),
      week52High: num(f[14]),
      week52Low: num(f[15]),
      // 点差（以 pip 计）：交易成本的直观度量
      spreadPips: bid != null && ask != null && meta?.pip ? +((ask - bid) / meta.pip).toFixed(2) : null,
    });
  }
  return out;
}

const SINACODES = PAIRS.map((p) => p.sina);

export async function fetchQuotes() {
  const url = `https://hq.sinajs.cn/list=${SINACODES.join(',')}`;
  const { buf, ms } = await getText(url, {
    source: 'sina',
    headers: { Referer: 'https://finance.sina.com.cn' },
    timeoutMs: 8000,
    retries: 1,
  });
  const text = new TextDecoder('gbk').decode(buf);
  const quotes = parseSinaPayload(text);
  if (!quotes.length) throw new Error('新浪返回空报价');
  return { quotes, latencyMs: ms, fetchedAt: new Date().toISOString() };
}

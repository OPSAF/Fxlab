/**
 * 静态模式 API —— 没有后端时，把服务端的活儿全搬到浏览器里干。
 *
 * 为什么可行：
 *  - 指标 / 策略 / 回测 / 统计本来就是纯 JS，已经通过 scripts/sync-core.mjs
 *    复制到 web/js/core/，浏览器可以直接 import；
 *  - 数据源里有两家带 CORS 头：Frankfurter（`*`）与东方财富（回显 Origin），
 *    所以浏览器能直接取。新浪没有 CORS 且校验 Referer，静态模式只能放弃它。
 *
 * 契约：与 server/index.mjs 的 REST 接口保持同样的路径与返回结构，
 * 这样前端代码一行都不用分叉。
 */
import { PAIRS, pairMap, SOURCES, sourceInfo, TIMEFRAMES } from './core/pairs.mjs';
import { simulateDaily } from './core/simulator.mjs';
import { strategyCatalog, getStrategy, resolveParams } from './core/strategies.mjs';
import { evaluate, gridSearch } from './core/backtest.mjs';
import { analyze } from './core/stats.mjs';
import { sma, ema, rsi, atr, bollinger, donchian } from './core/indicators.mjs';

export const MODE = 'static';
export const POLL_MS = 5000;
const LIMITS = { maxBars: 20000, maxGridCells: 1600 };

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
const pad = (n) => String(n).padStart(2, '0');
const hhmmss = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
  const promise = Promise.resolve().then(fn);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}

/** 健康度：静态模式下也保留「哪家数据源什么时候成功过」 */
const health = new Map();
function mark(source, ok, ms, error) {
  const h = health.get(source) || { source, calls: 0, failures: 0 };
  h.calls += 1;
  if (ok) {
    h.lastOk = new Date().toISOString();
    h.latencyMs = ms;
    h.errMsg = null;
  } else {
    h.failures += 1;
    h.lastErr = new Date().toISOString();
    h.errMsg = String(error).slice(0, 200);
  }
  health.set(source, h);
}

/* ------------------------------------------------------------------ *
 * 数据抓取（全部走 CORS 允许的接口）
 * ------------------------------------------------------------------ */
const EMPTY_MSG = '东方财富返回空数据';

async function loadQuotes() {
  const t0 = Date.now();
  const ids = PAIRS.map((p) => p.em).join(',');
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${ids}&fltt=2&invt=2&fields=f2,f3,f4,f12,f13,f14,f15,f16,f17,f18,f31,f32`;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const diff = j?.data?.diff;
    const rows = Array.isArray(diff) ? diff : Object.values(diff || {});
    const byId = new Map(rows.map((x) => [`${x.f13}.${x.f12}`, x]));
    const now = new Date();
    const out = [];
    for (const p of PAIRS) {
      const row = byId.get(p.em);
      if (!row || !Number.isFinite(row.f2) || row.f2 <= 0) continue;
      const bid = Number.isFinite(row.f31) ? row.f31 : row.f2;
      const ask = Number.isFinite(row.f32) ? row.f32 : row.f2;
      const prevClose = Number.isFinite(row.f18) ? row.f18 : null;
      out.push({
        symbol: p.symbol,
        time: hhmmss(now),
        date: ymd(now),
        bid,
        ask,
        last: row.f2,
        prevClose,
        open: Number.isFinite(row.f17) ? row.f17 : null,
        high: Number.isFinite(row.f15) ? row.f15 : null,
        low: Number.isFinite(row.f16) ? row.f16 : null,
        nameZh: row.f14 || p.zh,
        changePct: Number.isFinite(row.f3) ? row.f3 : null,
        change: Number.isFinite(row.f4) ? row.f4 : null,
        amplitudePct: prevClose && row.f15 != null && row.f16 != null ? ((row.f15 - row.f16) / prevClose) * 100 : null,
        week52High: null,
        week52Low: null,
        spreadPips: p.pip ? +((ask - bid) / p.pip).toFixed(2) : null,
        receivedAt: now.toISOString(),
        latencyMs: Date.now() - t0,
      });
    }
    if (!out.length) throw new Error(EMPTY_MSG);
    mark('eastmoney', true, Date.now() - t0);
    return out;
  } catch (e) {
    mark('eastmoney', false, Date.now() - t0, e.message);
    throw e;
  }
}

const spark = new Map(); // symbol -> 最近 120 个价格

async function loadDaily(symbol, start = '1999-01-04', end = '') {
  const p = pairMap.get(symbol);
  if (!p) throw new Error(`未知货币对 ${symbol}`);
  const key = `daily:${p.from}${p.to}:${start}:${end}`;
  return cached(key, 30 * 60 * 1000, async () => {
    const t0 = Date.now();
    const url = `https://api.frankfurter.app/${start}..${end}?from=${p.from}&to=${p.to}`;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const bars = Object.entries(j.rates || {})
        .map(([date, val]) => ({ date, close: Number(val[p.to]) }))
        .filter((b) => Number.isFinite(b.close) && b.close > 0)
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      if (!bars.length) throw new Error('Frankfurter 无数据');
      mark('frankfurter', true, Date.now() - t0);
      return bars;
    } catch (e) {
      mark('frankfurter', false, Date.now() - t0, e.message);
      throw e;
    }
  });
}

async function loadIntraday(symbol) {
  const p = pairMap.get(symbol);
  const key = `intraday:${p.em}`;
  return cached(key, 20 * 1000, async () => {
    const t0 = Date.now();
    const url =
      `https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=${p.em}&ndays=1&iscr=0` +
      `&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57`;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const rows = j?.data?.trends;
      if (!Array.isArray(rows) || !rows.length) throw new Error(EMPTY_MSG);
      const bars = [];
      for (const row of rows) {
        const [ts, o, c, h, l] = row.split(',');
        const open = Number(o);
        const close = Number(c);
        const high = Number(h);
        const low = Number(l);
        if (![open, close, high, low].every(Number.isFinite) || open <= 0 || close <= 0) continue;
        bars.push({ t: ts.replace(' ', 'T') + ':00+08:00', date: ts.slice(0, 10), open, high, low, close });
      }
      mark('eastmoney', true, Date.now() - t0);
      return bars;
    } catch (e) {
      mark('eastmoney', false, Date.now() - t0, e.message);
      throw e;
    }
  });
}

/* ------------------------------------------------------------------ *
 * 数据集装配（与服务端 dataset.mjs 同口径）
 * ------------------------------------------------------------------ */
async function loadDataset({ symbol, source = 'ecb', start, end, days = 2500, seed = 20260101 }) {
  const meta = sourceInfo(source);
  const pair = pairMap.get(symbol);
  if (!pair) throw new Error(`未知货币对 ${symbol}`);

  let bars;
  if (source === 'ecb') {
    const s = start || '2010-01-01';
    const raw = await loadDaily(symbol, s, end || '');
    // Frankfurter 的区间接口会把 start 之前最近的一个交易日也带回来，
    // 服务端是 slice(date >= start) 切掉的，这里必须保持同一口径，否则会多一根 K 线。
    bars = raw
      .filter((b) => b.date >= s && (!end || b.date <= end))
      .map((b) => ({ date: b.date, open: b.close, high: b.close, low: b.close, close: b.close }));
  } else if (source === 'em') {
    bars = await loadIntraday(symbol);
  } else if (source === 'sim') {
    bars = simulateDaily(symbol, { start: start || '2015-01-01', days: Number(days) || 2500, seed: Number(seed) || 20260101 });
  } else {
    throw new Error(`未知数据源 ${source}`);
  }
  if (!bars.length) throw new Error('数据集为空');
  return {
    symbol,
    source,
    meta: { ...meta, rows: bars.length, start: bars[0].date ?? bars[0].t, end: bars.at(-1).date ?? bars.at(-1).t },
    bars,
  };
}

const trim = (arr, keep) => arr.slice(Math.max(0, arr.length - keep));

/* ------------------------------------------------------------------ *
 * 端点实现
 * ------------------------------------------------------------------ */
async function chart(body) {
  const { symbol, source, start, end, days, seed, indicators = [] } = body;
  const ds = await loadDataset({ symbol, source, start, end, days, seed });
  const pair = pairMap.get(symbol);
  const closes = ds.bars.map((b) => b.close);
  const overlays = [];
  const osc = [];

  if (indicators.includes('sma')) {
    overlays.push({ key: 'sma20', label: 'SMA20', color: '#4dabf7', values: sma(closes, 20) });
    overlays.push({ key: 'sma60', label: 'SMA60', color: '#f0b429', values: sma(closes, 60) });
  }
  if (indicators.includes('ema')) {
    overlays.push({ key: 'ema20', label: 'EMA20', color: '#9775fa', values: ema(closes, 20) });
    overlays.push({ key: 'ema60', label: 'EMA60', color: '#63e6be', values: ema(closes, 60) });
  }
  if (indicators.includes('boll')) {
    const b = bollinger(closes, 20, 2);
    overlays.push({ key: 'bmid', label: 'BOLL 中轨', color: '#8d99ae', values: b.mid });
    overlays.push({ key: 'bup', label: 'BOLL 上轨', color: '#ff8787', values: b.upper });
    overlays.push({ key: 'bdn', label: 'BOLL 下轨', color: '#63e6be', values: b.lower });
  }
  if (indicators.includes('donchian')) {
    const d = donchian(ds.bars, 20);
    overlays.push({ key: 'dch_up', label: 'DON20↑', color: '#ffa94d', values: d.upper });
    overlays.push({ key: 'dch_dn', label: 'DON20↓', color: '#4dd4ac', values: d.lower });
  }
  if (indicators.includes('rsi')) osc.push({ key: 'rsi', label: 'RSI14', color: '#9775fa', values: rsi(closes, 14), kind: 'rsi' });
  if (indicators.includes('atr')) osc.push({ key: 'atr', label: 'ATR14', color: '#f0b429', values: atr(ds.bars, 14), kind: 'atr' });

  const keep = Math.min(ds.bars.length, 6000);
  return {
    symbol,
    source,
    digits: pair?.digits ?? 5,
    pip: pair?.pip ?? 0.0001,
    meta: ds.meta,
    bars: trim(ds.bars, keep),
    overlays: overlays.map((o) => ({ ...o, values: trim(o.values, keep) })),
    osc: osc.map((o) => ({ ...o, values: trim(o.values, keep) })),
  };
}

async function backtest(body) {
  const { symbol, source, strategyId, params, costs, start, end, days, seed, trainRatio } = body;
  const ds = await loadDataset({ symbol, source, start, end, days, seed });
  const pair = pairMap.get(symbol);
  const c = {
    costPips: Number(costs?.costPips ?? 1),
    pip: pair?.pip ?? 0.0001,
    annualBars: sourceInfo(source).annualBars,
  };
  const res = evaluate({ bars: ds.bars, strategyId, params, costs: c });

  let split = null;
  if (trainRatio > 0 && trainRatio < 1) {
    const idx = Math.floor(ds.bars.length * trainRatio);
    split = {
      ratio: trainRatio,
      index: idx,
      date: ds.bars[idx]?.date ?? ds.bars[idx]?.t,
      inSample: evaluate({ bars: ds.bars.slice(0, idx), strategyId, params, costs: c }).metrics,
      outOfSample: evaluate({ bars: ds.bars.slice(idx), strategyId, params, costs: c }).metrics,
    };
  }

  const n = ds.bars.length;
  const keep = Math.min(n, 4000);
  const startIdx = n - keep;
  return {
    symbol,
    source,
    meta: ds.meta,
    strategy: { id: strategyId, name: getStrategy(strategyId).name, params: res.params },
    metrics: res.metrics,
    benchmark: res.benchmark,
    split,
    trades: res.trades.slice(-200),
    overlays: res.overlays.map((o) => ({ ...o, values: trim(o.values, keep) })),
    series: {
      dates: trim(res.series.dates, keep),
      close: trim(res.series.close, keep),
      equity: trim(res.series.equity, keep),
      drawdown: trim(res.series.drawdown, keep),
      positions: trim(res.positions, keep),
      benchmark: trim(res.series.close, keep).map((v) => v / res.series.close[startIdx]),
    },
  };
}

async function grid(body) {
  const { symbol, source, strategyId, grid: g, costs, start, end, days, seed, trainRatio } = body;
  const ds = await loadDataset({ symbol, source, start, end, days, seed });
  const pair = pairMap.get(symbol);
  return gridSearch({
    bars: ds.bars,
    strategyId,
    grid: g,
    trainRatio: Number(trainRatio) || 0.7,
    costs: { costPips: Number(costs?.costPips ?? 1), pip: pair?.pip ?? 0.0001, annualBars: sourceInfo(source).annualBars },
  });
}

async function stats(body) {
  const { symbol, source, start, end, days, seed } = body;
  const ds = await loadDataset({ symbol, source, start, end, days, seed });
  const report = analyze(ds.bars, { annualBars: sourceInfo(source).annualBars });
  const keep = Math.min(ds.bars.length, 3000);
  report.rollingVol = report.rollingVol.slice(-keep);
  return { symbol, source, meta: ds.meta, report, bars: trim(ds.bars, keep) };
}

async function compare(body) {
  const { symbol, source, start, end, days, seed, costPips = 1, strategies = [] } = body;
  const ds = await loadDataset({ symbol, source, start, end, days, seed });
  const pair = pairMap.get(symbol);
  const costs = { costPips: Number(costPips), pip: pair?.pip ?? 0.0001, annualBars: sourceInfo(source).annualBars };
  const rows = strategies.map((s) => {
    try {
      const r = evaluate({ bars: ds.bars, strategyId: s.id, params: resolveParams(s.id, s.params), costs });
      return { id: s.id, name: getStrategy(s.id).name, params: r.params, metrics: r.metrics };
    } catch (e) {
      return { id: s.id, name: s.id, error: String(e.message) };
    }
  });
  return { symbol, source, meta: ds.meta, rows };
}

/* ---------------- 实验记录：静态模式存本地 ---------------- */
const LS_KEY = 'fxlab-experiments';
const memoryStore = [];

function readExperiments() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return memoryStore;
  }
}

function writeExperiments(list) {
  memoryStore.length = 0;
  memoryStore.push(...list);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式 / 配额满：退化为内存 */
  }
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */
export async function staticApi(path, body = {}) {
  const url = new URL(path, 'http://local');
  const route = url.pathname;

  switch (true) {
    case route === '/api/meta':
      return {
        pairs: PAIRS,
        sources: SOURCES,
        strategies: strategyCatalog(),
        timeframes: Object.keys(TIMEFRAMES),
        pollMs: POLL_MS,
        limits: LIMITS,
        mode: MODE,
        now: new Date().toISOString(),
      };

    case route === '/api/quotes': {
      const quotes = await loadQuotes();
      for (const q of quotes) {
        const arr = spark.get(q.symbol) || [];
        if (arr[arr.length - 1] !== q.last) arr.push(q.last);
        while (arr.length > 120) arr.shift();
        spark.set(q.symbol, arr);
      }
      return {
        at: new Date().toISOString(),
        lastPollAt: Date.now(),
        error: null,
        quotes,
        spark: Object.fromEntries(spark),
      };
    }

    case route === '/api/history': {
      const ds = await loadDataset({
        symbol: url.searchParams.get('symbol') || 'EURUSD',
        source: url.searchParams.get('source') || 'ecb',
        start: url.searchParams.get('start') || undefined,
        end: url.searchParams.get('end') || undefined,
        days: Number(url.searchParams.get('days') || 2500),
        seed: Number(url.searchParams.get('seed') || 20260101),
      });
      return { symbol: ds.symbol, source: ds.source, meta: ds.meta, bars: trim(ds.bars, 6000) };
    }

    case route === '/api/chart':
      return chart(body);

    case route === '/api/backtest':
      return backtest(body);

    case route === '/api/grid':
      return grid(body);

    case route === '/api/stats':
      return stats(body);

    case route === '/api/compare':
      return compare(body);

    case route === '/api/health':
      return {
        ok: true,
        mode: MODE,
        // 即使还没发过请求，也把两家数据源列出来，界面不会空着
        sources: ['eastmoney', 'frankfurter'].map(
          (name) => health.get(name) || { source: name, calls: 0, failures: 0, lastOk: null, latencyMs: null },
        ),
        live: { lastPollAt: Date.now(), lastError: null, pollMs: POLL_MS, clients: 1 },
        capture: { active: false, supported: false, symbol: '', ticks: 0, persisted: 0, counts: {} },
        uptimeSec: Math.round(performance.now() / 1000),
      };

    case route === '/api/capture':
      return { capture: { active: false, supported: false, symbol: '', ticks: 0, persisted: 0, counts: {} } };

    case route === '/api/experiments':
      if (body && body.name) {
        const item = { at: new Date().toISOString(), ...body };
        const list = readExperiments();
        list.push(item);
        writeExperiments(list);
        return { ok: true, item };
      }
      return { items: readExperiments().slice(-60).reverse() };

    default:
      throw new Error(`静态模式不支持的接口：${route}`);
  }
}

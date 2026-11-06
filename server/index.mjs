/**
 * fxlab 服务端入口：静态资源 + REST API + SSE 实时推送。
 *
 * 选型说明（为什么这么写）：
 *  - 零依赖：只用 node:http / node:fs，读者不需要 npm install 就能跑起来读源码；
 *  - 实时推送用 SSE 而不是 WebSocket：行情是单向广播，SSE 天生够用且浏览器自带断线重连；
 *  - 数据抓取放在服务端：浏览器直连新浪会被 CORS 和 Referer 校验挡掉。
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { WEB_DIR, PAIRS, pairMap, SERVER, LIMITS } from './config.mjs';
import { fetchQuotes } from './providers/sina.mjs';
import { healthSnapshot } from './providers/http.mjs';
import { loadDataset, SOURCES, sourceInfo } from './core/dataset.mjs';
import { evaluate, gridSearch } from './core/backtest.mjs';
import { strategyCatalog, getStrategy, resolveParams } from './core/strategies.mjs';
import { analyze } from './core/stats.mjs';
import { BarAggregator, TIMEFRAMES } from './core/bar-aggregator.mjs';
import { sma, ema, rsi, atr, bollinger, donchian } from './core/indicators.mjs';
import { ensureDirs, appendJSONL, readJSONL } from './core/store.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------------ *
 * 实时行情状态
 * ------------------------------------------------------------------ */
const live = {
  quotes: new Map(),
  history: new Map(), // symbol -> [{t, p}]
  lastPollAt: null,
  lastError: null,
  pollMs: SERVER.pollMs,
  capture: { symbol: 'EURUSD', active: false, agg: null, startedAt: null, ticks: 0, persisted: 0 },
};

const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

async function pollOnce() {
  try {
    const t0 = Date.now();
    const { quotes, latencyMs } = await fetchQuotes();
    const now = Date.now();
    for (const q of quotes) {
      live.quotes.set(q.symbol, { ...q, receivedAt: new Date(now).toISOString(), latencyMs });
      const arr = live.history.get(q.symbol) || [];
      arr.push({ t: now, p: q.last });
      while (arr.length > 600) arr.shift();
      live.history.set(q.symbol, arr);

      if (live.capture.active && q.symbol === live.capture.symbol && live.capture.agg) {
        live.capture.agg.push(q.last, now);
        live.capture.ticks += 1;
      }
    }
    live.lastPollAt = Date.now();
    live.lastError = null;
    broadcast('quotes', { at: new Date(now).toISOString(), quotes, latencyMs: latencyMs ?? Date.now() - t0 });
  } catch (err) {
    live.lastError = String(err.message || err);
    broadcast('status', { ok: false, error: live.lastError, at: new Date().toISOString() });
  }
}

let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollOnce();
  pollTimer = setInterval(pollOnce, SERVER.pollMs);
  pollTimer.unref?.();
}

/* ------------------------------------------------------------------ *
 * 采集器
 * ------------------------------------------------------------------ */
function startCapture(symbol) {
  if (!pairMap.has(symbol)) throw new Error(`未知货币对 ${symbol}`);
  const agg = new BarAggregator(symbol, ['5s', '15s', '1m', '5m'], {
    maxBars: 4000,
    onClose: (frame, bar) => {
      // 只把 15s 及以上周期落盘，避免 5s 数据把磁盘写爆（教学取舍）
      if (frame === '5s') return;
      live.capture.persisted += 1;
      appendJSONL(`${symbol}-${frame}-${bar.t.slice(0, 10)}.jsonl`, bar, 'bars').catch(() => {});
    },
  });
  live.capture = { symbol, active: true, agg, startedAt: new Date().toISOString(), ticks: 0, persisted: 0 };
  return live.capture;
}

function stopCapture() {
  live.capture.active = false;
  return live.capture;
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2_000_000) throw new Error('请求体过大');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/** 只保留最后 maxBars 根，避免把几十年日线全塞给前端 */
function trimBars(bars, max = 6000) {
  return bars.length > max ? bars.slice(-max) : bars;
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */
const API = {
  'GET /api/meta': async () => ({
    pairs: PAIRS,
    sources: SOURCES,
    strategies: strategyCatalog(),
    timeframes: Object.keys(TIMEFRAMES),
    pollMs: live.pollMs,
    limits: LIMITS,
    now: new Date().toISOString(),
  }),

  'GET /api/health': async () => ({
    ok: true,
    sources: healthSnapshot(),
    live: { lastPollAt: live.lastPollAt, lastError: live.lastError, pollMs: live.pollMs, clients: sseClients.size },
    capture: {
      symbol: live.capture.symbol,
      active: live.capture.active,
      startedAt: live.capture.startedAt,
      ticks: live.capture.ticks,
      persisted: live.capture.persisted,
    },
    uptimeSec: Math.round(process.uptime()),
  }),

  'GET /api/quotes': async () => ({
    at: new Date().toISOString(),
    lastPollAt: live.lastPollAt,
    error: live.lastError,
    quotes: [...live.quotes.values()],
    spark: Object.fromEntries([...live.history.entries()].map(([k, v]) => [k, v.slice(-120).map((x) => x.p)])),
  }),

  'GET /api/history': async (url) => {
    const q = url.searchParams;
    const symbol = q.get('symbol') || 'EURUSD';
    const source = q.get('source') || 'ecb';
    const ds = await loadDataset({
      symbol,
      source,
      start: q.get('start') || undefined,
      end: q.get('end') || undefined,
      days: Number(q.get('days') || 2500),
      seed: Number(q.get('seed') || 20260101),
    });
    return {
      symbol,
      source,
      meta: ds.meta,
      bars: trimBars(ds.bars),
    };
  },

  'POST /api/chart': async (_url, body) => {
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
    const cut = (arr) => arr.slice(arr.length - keep);
    return {
      symbol,
      source,
      digits: pair?.digits ?? 5,
      pip: pair?.pip ?? 0.0001,
      meta: ds.meta,
      bars: cut(ds.bars),
      overlays: overlays.map((o) => ({ ...o, values: cut(o.values) })),
      osc: osc.map((o) => ({ ...o, values: cut(o.values) })),
    };
  },

  'POST /api/backtest': async (_url, body) => {
    const { symbol, source, strategyId, params, costs, start, end, days, seed, trainRatio } = body;
    const ds = await loadDataset({ symbol, source, start, end, days, seed });
    const pair = pairMap.get(symbol);
    const c = {
      costPips: Number(costs?.costPips ?? 1),
      pip: pair?.pip ?? 0.0001,
      annualBars: sourceInfo(source).annualBars,
    };
    const res = evaluate({ bars: ds.bars, strategyId, params, costs: c });

    // 可选的样本内外切分：用于观察「样本内漂亮、样本外塌方」
    let split = null;
    if (trainRatio && trainRatio > 0 && trainRatio < 1) {
      const idx = Math.floor(ds.bars.length * trainRatio);
      const isPart = evaluate({ bars: ds.bars.slice(0, idx), strategyId, params, costs: c });
      const osPart = evaluate({ bars: ds.bars.slice(idx), strategyId, params, costs: c });
      split = {
        ratio: trainRatio,
        index: idx,
        date: ds.bars[idx]?.date ?? ds.bars[idx]?.t,
        inSample: isPart.metrics,
        outOfSample: osPart.metrics,
      };
    }

    // 只回传画图需要的尾部，减少传输
    const n = ds.bars.length;
    const keep = Math.min(n, 4000);
    return {
      symbol,
      source,
      meta: ds.meta,
      strategy: { id: strategyId, name: getStrategy(strategyId).name, params: res.params },
      metrics: res.metrics,
      benchmark: res.benchmark,
      split,
      trades: res.trades.slice(-200),
      overlays: res.overlays.map((o) => ({ ...o, values: o.values.slice(n - keep) })),
      series: {
        dates: res.series.dates.slice(n - keep),
        close: res.series.close.slice(n - keep),
        equity: res.series.equity.slice(n - keep),
        drawdown: res.series.drawdown.slice(n - keep),
        positions: res.positions.slice(n - keep),
        // 买入持有基准（首日归一化到 1，与权益曲线同起点）
        benchmark: res.series.close.slice(n - keep).map((c) => c / res.series.close[n - keep]),
      },
    };
  },

  'POST /api/grid': async (_url, body) => {
    const { symbol, source, strategyId, grid, costs, start, end, days, seed, trainRatio } = body;
    const ds = await loadDataset({ symbol, source, start, end, days, seed });
    const pair = pairMap.get(symbol);
    return gridSearch({
      bars: ds.bars,
      strategyId,
      grid,
      trainRatio: Number(trainRatio) || 0.7,
      costs: {
        costPips: Number(costs?.costPips ?? 1),
        pip: pair?.pip ?? 0.0001,
        annualBars: sourceInfo(source).annualBars,
      },
    });
  },

  'POST /api/stats': async (_url, body) => {
    const { symbol, source, start, end, days, seed } = body;
    const ds = await loadDataset({ symbol, source, start, end, days, seed });
    const report = analyze(ds.bars, { annualBars: sourceInfo(source).annualBars });
    const keep = Math.min(ds.bars.length, 3000);
    // 价格与滚动波动率必须切成同一段，否则前端画图会错位
    report.rollingVol = report.rollingVol.slice(-keep);
    return {
      symbol,
      source,
      meta: ds.meta,
      report,
      bars: ds.bars.slice(-keep),
    };
  },

  'POST /api/compare': async (_url, body) => {
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
  },

  'POST /api/capture': async (_url, body) => {
    const action = body.action || 'status';
    if (action === 'start') {
      startCapture(body.symbol || 'EURUSD');
      return { capture: statusCapture() };
    }
    if (action === 'stop') {
      stopCapture();
      return { capture: statusCapture() };
    }
    if (action === 'reset' && live.capture.agg) {
      live.capture.agg.reset();
      live.capture.ticks = 0;
      return { capture: statusCapture() };
    }
    return { capture: statusCapture() };
  },

  'GET /api/capture': async (url) => {
    const frame = url.searchParams.get('frame') || '1m';
    return { capture: statusCapture(), frame, bars: live.capture.agg ? live.capture.agg.series(frame) : [] };
  },

  'GET /api/experiments': async () => ({ items: await readJSONL('experiments.jsonl', { kind: 'experiments', limit: 60 }).then((a) => a.slice(-60).reverse()) }),

  'POST /api/experiments': async (_url, body) => {
    const item = { at: new Date().toISOString(), ...body };
    await appendJSONL('experiments.jsonl', item, 'experiments');
    return { ok: true, item };
  },
};

function statusCapture() {
  const c = live.capture;
  return {
    symbol: c.symbol,
    active: c.active,
    startedAt: c.startedAt,
    ticks: c.ticks,
    persisted: c.persisted,
    frames: c.agg ? Object.keys(TIMEFRAMES).filter((f) => (c.agg.state.get(f)?.bars.length ?? 0) > 0) : [],
    counts: c.agg ? Object.fromEntries([...c.agg.state.entries()].map(([f, s]) => [f, s.bars.length])) : {},
  };
}

/* ------------------------------------------------------------------ *
 * 静态文件
 * ------------------------------------------------------------------ */
async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) return json(res, 403, { error: 'forbidden' });
  if (!existsSync(file)) return json(res, 404, { error: `not found: ${rel}` });
  const ext = path.extname(file).toLowerCase();
  const data = await fs.readFile(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(data);
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type' });
    return res.end();
  }

  if (url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\n\n`);
    sseClients.add(res);
    const quotes = [...live.quotes.values()];
    if (quotes.length) res.write(`event: quotes\ndata: ${JSON.stringify({ at: new Date().toISOString(), quotes })}\n\n`);
    const hb = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(hb);
      sseClients.delete(res);
    });
    return;
  }

  const key = `${req.method} ${url.pathname}`;
  const handler = API[key];
  if (handler) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const result = await handler(url, body);
      return json(res, 200, result);
    } catch (err) {
      console.error(`[api] ${key} 失败:`, err);
      return json(res, 500, { error: String(err.message || err) });
    }
  }

  if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'unknown endpoint' });
  return serveStatic(req, res, url.pathname);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[fatal]', err);
    if (!res.headersSent) json(res, 500, { error: String(err.message || err) });
    else res.end();
  });
});

await ensureDirs();
startPolling();

function listen(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 10) {
      listen(port + 1, attempt + 1);
    } else {
      console.error('启动失败:', err);
      process.exit(1);
    }
  });
  server.listen(port, SERVER.host, () => {
    const addr = server.address();
    console.log(`\n  FX 量化实验室已启动`);
    console.log(`  → http://${SERVER.host}:${addr.port}`);
    console.log(`  数据源: 新浪实时报价 / ECB 日线 / 东财分钟线 / 内置模拟器`);
    console.log(`  轮询: ${SERVER.pollMs}ms   数据目录: ./data\n`);
  });
}

listen(SERVER.port);

process.on('SIGINT', () => {
  console.log('\n正在关闭…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});

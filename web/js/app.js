/**
 * 前端主逻辑。
 *
 * 结构：状态(state) → 拉数据(api) → 渲染(render*) → 交互(bind*)。
 * 所有数值展示都走 format 函数，避免同一个数字在不同地方口径不一致。
 */
import { priceChart, lineChart, histogramChart, acfChart, heatmap, sparkline, setupCanvas } from './chart.js';
import { LESSONS } from './lessons.js';
import { staticApi } from './static-api.mjs';

/* ------------------------------------------------------------------ *
 * 运行模式：有后端就用后端；没有（例如 GitHub Pages）就用浏览器直连数据源
 * ------------------------------------------------------------------ */
let MODE = 'server';

async function detectMode() {
  try {
    const r = await fetch('./api/meta', { headers: { accept: 'application/json' } });
    if (!r.ok) return 'static';
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return 'static';
    const j = await r.json();
    return Array.isArray(j?.pairs) ? 'server' : 'static';
  } catch {
    return 'static';
  }
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const fmtPrice = (v, digits = 5) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
const fmtPct = (v, d = 2) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const fmtSigned = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%` : '—');
const fmtNum2 = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const timeStr = (iso) => (iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }) : '—');
/** 读 CSS 变量，让图表颜色跟着主题走 */
const cssVar = (name, fb) => {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
  } catch {
    return fb;
  }
};

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${isErr ? ' err' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = 'toast'), 2600);
}

async function api(path, body) {
  if (MODE === 'static') return staticApi(path, body);
  const init = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */
const state = {
  meta: null,
  quotes: new Map(),
  spark: {},
  selected: 'EURUSD',
  liveHistory: [],
  capture: null,
  bt: null,
  grid: null,
  stats: null,
  sseOk: false,
  digitsOf: (sym) => state.meta?.pairs.find((p) => p.symbol === sym)?.digits ?? 5,
};

/* ------------------------------------------------------------------ *
 * 主题：浅色「纸面」为默认，跟随系统，可手动切换并记忆
 * ------------------------------------------------------------------ */
function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem('fxlab-theme');
  } catch {
    /* 隐私模式下不可用 */
  }
  const prefersDark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'dark' : 'light'), false);
}

function applyTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  if (persist) {
    try {
      localStorage.setItem('fxlab-theme', theme);
    } catch {
      /* 忽略 */
    }
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && theme === 'dark') meta.setAttribute('content', '#121316');
  // 主题变了，Canvas 里的颜色是从 CSS 变量读的，必须重绘一遍
  requestAnimationFrame(() => redrawVisible());
}

/** 只重绘当前可见视图里已经画过的东西，不重新发请求 */
function redrawVisible() {
  if (!state.meta) return; // 首屏：meta 还没回来，先别画，否则会读到 null
  renderPairs();
  if (state.liveBars) drawLiveChart(state.liveBars, state.digitsOf(state.selected), state.liveLabel);
  if (state.chartData) drawChartView();
  if (state.bt) renderBacktest(state.bt);
  if (state.stats) renderStats(state.stats);
  if (state.grid) drawGridCharts(state.grid);
}

/* ------------------------------------------------------------------ *
 * 初始化
 * ------------------------------------------------------------------ */
async function init() {
  initTheme();

  MODE = await detectMode();

  try {
    state.meta = await api('/api/meta');
  } catch (e) {
    toast(`无法连接服务端：${e.message}`, true);
    return;
  }

  wireTabs();
  fillSelects();
  renderLessons();
  wireMarket();
  wireChart();
  wireBacktest();
  wireStats();
  wireLog();
  connectStream();

  const themeBtn = $('#theme-btn');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
    });
  }

  // 首次加载
  await refreshQuotes();
  loadLiveChart(state.selected);
  runChart();
  runBacktest();
  runStats();
  loadLog();
  setInterval(refreshHealth, 12000);
  refreshHealth();
}

function wireTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      location.hash = tab.dataset.view;
      activateView(tab.dataset.view);
    });
  });
  window.addEventListener('hashchange', () => activateView(location.hash.slice(1)));
  if (location.hash.length > 1) activateView(location.hash.slice(1));
}

function activateView(name) {
  const target = $(`.tab[data-view="${name}"]`);
  if (!target) return;
  $$('.tab').forEach((t) => t.classList.toggle('active', t === target));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  // 切换视图后重绘：canvas 在隐藏状态下尺寸是 0，必须重新量一次
  setTimeout(() => window.dispatchEvent(new Event('resize')), 30);
}

function fillSelects() {
  const pairs = state.meta.pairs.map((p) => `<option value="${p.symbol}">${p.symbol} · ${p.zh}</option>`).join('');
  const sources = state.meta.sources.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  ['#chart-symbol', '#bt-symbol', '#st-symbol'].forEach((s) => ($(s).innerHTML = pairs));
  ['#chart-source', '#bt-source', '#st-source'].forEach((s) => ($(s).innerHTML = sources));

  const strat = state.meta.strategies.map((s) => `<option value="${s.id}">${s.name}（${s.zh}）</option>`).join('');
  $('#bt-strategy').innerHTML = strat;
  renderStrategyParams();
}

/* ------------------------------------------------------------------ *
 * 实时行情（SSE）
 * ------------------------------------------------------------------ */
function connectStream() {
  if (MODE === 'static') {
    // 静态托管没有 SSE，改为浏览器定时拉取（东财一次请求可取回全部货币对）
    setStatus(true, '静态模式 · 浏览器直连');
    refreshQuotes();
    setInterval(refreshQuotes, 5000);
    return;
  }
  const es = new EventSource('./api/stream');
  es.addEventListener('quotes', (ev) => {
    state.sseOk = true;
    const payload = JSON.parse(ev.data);
    applyQuotes(payload.quotes, payload.at);
  });
  es.addEventListener('status', (ev) => {
    const s = JSON.parse(ev.data);
    if (!s.ok) setStatus(false, `数据源异常：${s.error}`);
  });
  es.onerror = () => {
    state.sseOk = false;
    setStatus(false, 'SSE 断开，重连中…');
  };
}

function setStatus(live, text) {
  const dot = $('#live-dot');
  dot.className = `dot ${live ? 'live' : 'err'}`;
  $('#live-text').textContent = text;
}

async function refreshQuotes() {
  try {
    const q = await api('/api/quotes');
    applyQuotes(q.quotes, q.at);
    if (q.error) setStatus(false, `数据源异常：${q.error}`);
  } catch (e) {
    setStatus(false, `离线：${e.message}`);
  }
}

function applyQuotes(quotes, at) {
  for (const q of quotes) {
    state.quotes.set(q.symbol, q);
    // 本地累积迷你走势（SSE 不传全量 spark，省带宽）
    const arr = state.spark[q.symbol] || [];
    if (arr[arr.length - 1] !== q.last) arr.push(q.last);
    while (arr.length > 120) arr.shift();
    state.spark[q.symbol] = arr;
  }
  const first = quotes[0];
  setStatus(true, `实时 · ${timeStr(at)} · ${first?.latencyMs ?? '—'}ms`);
  $('#quote-updated').textContent = `更新于 ${timeStr(at)}`;
  renderPairs();
  renderQuoteDetail();
  renderLiveLegend();
}

/* ------------------------------------------------------------------ *
 * 市场页
 * ------------------------------------------------------------------ */
function wireMarket() {
  $('#capture-btn').addEventListener('click', async () => {
    if (MODE === 'static') {
      toast('静态托管版没有后端，无法落盘采集；请用服务端分支或本地运行', true);
      return;
    }
    const on = state.capture?.active;
    try {
      const r = await api('/api/capture', { action: on ? 'stop' : 'start', symbol: state.selected });
      state.capture = r.capture;
      renderCapture();
      toast(on ? '采集已停止' : `开始采集 ${state.selected}`);
    } catch (e) {
      toast(e.message, true);
    }
  });
}

function renderPairs() {
  const list = $('#pair-list');
  const pairs = state.meta.pairs;
  if (!list.dataset.built) {
    list.innerHTML = pairs
      .map(
        (p) => `
      <div class="pair-row" data-symbol="${p.symbol}">
        <canvas class="spark" width="52" height="22"></canvas>
        <div class="pair-name"><b>${p.symbol}</b><span>${p.zh}</span></div>
        <div class="pair-price">—</div>
        <div class="pair-chg">—</div>
      </div>`,
      )
      .join('');
    list.dataset.built = '1';
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.pair-row');
      if (!row) return;
      selectPair(row.dataset.symbol);
    });
  }

  for (const p of pairs) {
    const row = list.querySelector(`[data-symbol="${p.symbol}"]`);
    if (!row) continue;
    const q = state.quotes.get(p.symbol);
    row.classList.toggle('active', p.symbol === state.selected);
    const price = row.querySelector('.pair-price');
    const chg = row.querySelector('.pair-chg');
    if (!q) continue;
    price.textContent = fmtPrice(q.last, p.digits);
    chg.textContent = fmtSigned((q.changePct ?? 0) / 100);
    chg.className = `pair-chg ${cls(q.changePct)}`;
    const spark = state.spark[p.symbol];
    if (spark?.length > 1) sparkline(row.querySelector('canvas'), spark);
  }

  // 顺便缓存 spark 供迷你图使用
  return list;
}

function selectPair(symbol) {
  state.selected = symbol;
  $('#live-title').textContent = `${symbol} · ${state.meta.pairs.find((p) => p.symbol === symbol)?.zh ?? ''}`;
  renderPairs();
  renderQuoteDetail();
  loadLiveChart(symbol);
  if (state.capture?.active) api('/api/capture', { action: 'start', symbol }).then((r) => ((state.capture = r.capture), renderCapture()));
}

function renderQuoteDetail() {
  const q = state.quotes.get(state.selected);
  const digits = state.digitsOf(state.selected);
  const dl = $('#quote-detail');
  if (!q) {
    dl.innerHTML = '<dt>状态</dt><dd>等待行情…</dd>';
    return;
  }
  dl.innerHTML = `
    <dt>最新 / 买价 / 卖价</dt><dd>${fmtPrice(q.last, digits)} / ${fmtPrice(q.bid, digits)} / ${fmtPrice(q.ask, digits)}</dd>
    <dt>点差</dt><dd>${q.spreadPips != null ? q.spreadPips + ' pip' : '—'}</dd>
    <dt>涨跌</dt><dd class="${cls(q.changePct)}">${fmtSigned((q.changePct ?? 0) / 100)} · ${fmtNum2(q.change, digits)}</dd>
    <dt>今开 / 昨收</dt><dd>${fmtPrice(q.open, digits)} / ${fmtPrice(q.prevClose, digits)}</dd>
    <dt>今日高 / 低</dt><dd>${fmtPrice(q.high, digits)} / ${fmtPrice(q.low, digits)}</dd>
    <dt>振幅</dt><dd>${fmtNum2(q.amplitudePct, 3)}%</dd>
    <dt>52 周区间</dt><dd>${fmtPrice(q.week52Low, digits)} – ${fmtPrice(q.week52High, digits)}</dd>
    <dt>行情时间</dt><dd>${q.time} ${q.date}</dd>
  `;
  $('#live-badge').textContent = `${q.time} 北京`;
}

async function loadLiveChart(symbol) {
  const digits = state.digitsOf(symbol);
  try {
    const r = await api(`/api/history?symbol=${symbol}&source=em`);
    drawLiveChart(r.bars, digits, '东财 1 分钟线 · 今日');
  } catch {
    // 东财没有该货币对时，退回「实时快照连线」
    const spark = state.spark[symbol] || [];
    drawLiveChart(spark.map((p, i) => ({ t: '', close: p, i })), digits, '实时快照连线');
  }
}

function drawLiveChart(bars, digits, label) {
  if (!bars.length) return;
  state.liveLabel = label;
  state.liveBars = bars;
  priceChart($('#live-chart'), { bars, overlays: [], digits, type: bars[0].high != null ? 'candle' : 'line' });
  renderLiveLegend();
}

function renderLiveLegend() {
  const q = state.quotes.get(state.selected);
  const digits = state.digitsOf(state.selected);
  const parts = [];
  if (q) parts.push(`<span>现价 <b class="${cls(q.changePct)}">${fmtPrice(q.last, digits)}</b> ${fmtSigned((q.changePct ?? 0) / 100)}</span>`);
  if (state.liveLabel) parts.push(`<span><i style="background:#4dabf7"></i>${state.liveLabel}</span>`);
  parts.push('<span>滚轮缩放 / 拖拽平移 ｜ 点左侧货币对刷新</span>');
  $('#live-legend').innerHTML = parts.join('');
}

/* ------------------------------------------------------------------ *
 * 数据健康度 / 采集器
 * ------------------------------------------------------------------ */
async function refreshHealth() {
  try {
    const h = await api('/api/health');
    state.capture = h.capture;
    const dl = $('#health-detail');
    dl.innerHTML = h.sources
      .map((s) => {
        const ok = s.failures === 0;
        const when = s.lastOk ? timeStr(s.lastOk) : '—';
        return `<dt>${s.source}</dt><dd class="${ok ? 'up' : 'down'}">${ok ? '正常' : s.failures + ' 次失败'} · ${s.latencyMs ?? '—'}ms · ${when}</dd>`;
      })
      .join('') + `<dt>实时轮询</dt><dd>${h.live.pollMs}ms · ${h.live.clients} 个订阅</dd>`;
    renderCapture();
  } catch {
    /* 静默 */
  }
}

function renderCapture() {
  const c = state.capture;
  const btn = $('#capture-btn');
  if (!c) return;
  if (c.supported === false) {
    btn.disabled = true;
    btn.textContent = '静态模式无采集';
    btn.title = '采集需要常驻后端进程；静态托管版请用服务端分支或本地运行';
    $('#capture-detail').innerHTML = '<dt>状态</dt><dd>不支持</dd><dt>原因</dt><dd>采集需要服务端进程</dd>';
    return;
  }
  btn.disabled = false;
  btn.textContent = c.active ? '停止采集' : '开始采集';
  btn.classList.toggle('primary', c.active);
  $('#capture-detail').innerHTML = `
    <dt>状态</dt><dd class="${c.active ? 'up' : ''}">${c.active ? '采集中 · ' + c.symbol : '未启动'}</dd>
    <dt>快照数</dt><dd>${c.ticks ?? 0}</dd>
    <dt>已落盘 K 线</dt><dd>${c.persisted ?? 0}</dd>
    <dt>各周期根数</dt><dd>${Object.entries(c.counts || {}).map(([k, v]) => `${k}:${v}`).join(' ') || '—'}</dd>
  `;
}

/* ------------------------------------------------------------------ *
 * 图表页
 * ------------------------------------------------------------------ */
function wireChart() {
  $('#chart-run').addEventListener('click', runChart);

  // 旧内核不支持 :has()，用 .on 类兜底高亮
  const syncChips = () => {
    $$('#indicator-chips input').forEach((i) => {
      const chip = i.closest?.('.chip');
      if (chip) chip.classList.toggle('on', i.checked);
    });
  };
  syncChips();
  $$('#indicator-chips input').forEach((c) =>
    c.addEventListener('change', () => {
      syncChips();
      runChart();
    }),
  );

  // 快捷区间：只改「起始日期」再复用同一条取数路径
  $$('#chart-range button').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#chart-range button').forEach((b) => b.classList.toggle('on', b === btn));
      const years = Number(btn.dataset.range);
      const d = new Date();
      d.setFullYear(d.getFullYear() - years);
      if (years >= 30) d.setFullYear(1999);
      $('#chart-start').value = d.toISOString().slice(0, 10);
      runChart();
    });
  });

  window.addEventListener('resize', debounce(() => {
    if ($('#view-chart').classList.contains('active') && state.chartData) drawChartView();
  }, 200));
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

async function runChart() {
  const symbol = $('#chart-symbol').value;
  const source = $('#chart-source').value;
  const start = $('#chart-start').value;
  const indicators = $$('#indicator-chips input:checked').map((i) => i.value);
  $('#chart-title').textContent = '载入中…';
  try {
    const r = await api('/api/chart', { symbol, source, start, indicators });
    state.chartData = r;
    drawChartView();
  } catch (e) {
    $('#chart-title').textContent = '载入失败';
    $('#chart-meta').textContent = e.message;
    toast(e.message, true);
  }
}

function drawChartView() {
  const d = state.chartData;
  if (!d) return;
  const pair = state.meta.pairs.find((p) => p.symbol === d.symbol);
  $('#chart-title').textContent = `${d.symbol} · ${pair?.zh ?? ''}`;
  $('#chart-meta').textContent = `${d.meta.name} · ${d.meta.rows} 根 ${d.meta.start} → ${d.meta.end}`;

  priceChart($('#price-chart'), {
    bars: d.bars,
    overlays: d.overlays,
    digits: d.digits,
    type: d.meta.hasOhlc ? 'candle' : 'line',
  });
  $('#price-legend').innerHTML = d.overlays
    .map((o) => `<span><i style="background:${o.color}"></i>${o.label}</span>`)
    .join('') + `<span>${d.meta.hasOhlc ? '蜡烛图' : '折线图（该源只有收盘价）'} · 滚轮缩放 / 拖拽平移</span>`;

  const osc = d.osc[0];
  const oscCanvas = $('#osc-chart');
  if (!osc) {
    const { ctx, w, h } = setupCanvas(oscCanvas);
    ctx.fillStyle = '#5f7188';
    ctx.font = '12px system-ui';
    ctx.fillText('未选择震荡指标（勾选 RSI 或 ATR）', 14, Math.min(26, h - 6));
    void w;
    return;
  }
  lineChart(oscCanvas, {
    series: [{ label: osc.label, color: osc.color, values: osc.values }],
    labels: d.bars.map((b) => b.date ?? b.t),
    yFmt: (v) => fmtNum2(v, osc.kind === 'rsi' ? 0 : 4),
    yMin: osc.kind === 'rsi' ? 0 : undefined,
    yMax: osc.kind === 'rsi' ? 100 : undefined,
  });
  if (osc.kind === 'rsi') {
    // 30/70 参考线：lineChart 的绘图区固定为 t=10 / b=22，这里按同一映射画
    const { ctx, h } = setupCanvas(oscCanvas);
    const plotH = h - 32;
    ctx.save();
    ctx.strokeStyle = '#3b5570';
    ctx.setLineDash([3, 3]);
    for (const v of [30, 70]) {
      const y = 10 + (1 - v / 100) * plotH;
      ctx.beginPath();
      ctx.moveTo(8, y);
      ctx.lineTo(oscCanvas.clientWidth - 58, y);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ *
 * 回测页
 * ------------------------------------------------------------------ */
function currentStrategy() {
  return state.meta.strategies.find((s) => s.id === $('#bt-strategy').value);
}

function renderStrategyParams() {
  const s = currentStrategy();
  if (!s) return;
  $('#bt-desc').textContent = s.desc;
  $('#bt-params').innerHTML = s.params
    .map(
      (p) => `<label>${p.label}<input type="number" data-param="${p.key}" value="${p.value}" min="${p.min}" max="${p.max}" step="${p.step}" /></label>`,
    )
    .join('');
}

function collectParams() {
  const out = {};
  $$('#bt-params input[data-param]').forEach((i) => {
    out[i.dataset.param] = Number(i.value);
  });
  return out;
}

function wireBacktest() {
  $('#bt-strategy').addEventListener('change', renderStrategyParams);
  $('#bt-run').addEventListener('click', runBacktest);
  $('#grid-run').addEventListener('click', runGrid);
  $('#bt-save').addEventListener('click', saveExperiment);
}

async function runBacktest() {
  const btn = $('#bt-run');
  btn.disabled = true;
  btn.textContent = '运行中…';
  try {
    const r = await api('/api/backtest', {
      symbol: $('#bt-symbol').value,
      source: $('#bt-source').value,
      start: $('#bt-start').value,
      strategyId: $('#bt-strategy').value,
      params: collectParams(),
      costs: { costPips: Number($('#bt-cost').value) },
      trainRatio: Number($('#bt-train').value),
    });
    state.bt = r;
    renderBacktest(r);
  } catch (e) {
    toast(`回测失败：${e.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '运行回测';
  }
}

function renderBacktest(r) {
  const m = r.metrics;
  const b = r.benchmark;
  const cards = [
    ['总收益', fmtSigned(m.totalReturn, 1), `基准 ${fmtSigned(b.totalReturn, 1)}`, m.totalReturn],
    ['年化收益 CAGR', fmtSigned(m.cagr, 2), `${m.years} 年`, m.cagr],
    ['夏普比率', fmtNum2(m.sharpe), `基准 ${fmtNum2(b.sharpe)}`, m.sharpe],
    ['索提诺', fmtNum2(m.sortino), '只惩罚下行波动', m.sortino],
    ['最大回撤', fmtPct(m.maxDD, 1), `卡玛 ${fmtNum2(m.calmar)}`, m.maxDD],
    ['年化波动', fmtPct(m.annVol, 1), `基准 ${fmtPct(b.annVol, 1)}`, -1],
    ['胜率', fmtPct(m.winRate, 1), `${m.nTrades} 笔交易`, 0],
    ['盈亏比', m.profitFactor === Infinity ? '∞' : fmtNum2(m.profitFactor), '总盈利/总亏损', m.profitFactor - 1],
    ['成本拖累', fmtPct(m.costDrag, 1), `累计 ${(m.totalCost * 100).toFixed(2)}%`, -1],
    ['持仓占比', fmtPct(m.exposure, 0), `平均持仓 ${fmtNum2(m.avgHoldBars, 0)} 根`, 0],
  ];
  $('#bt-metrics').innerHTML = cards
    .map(([k, v, s, sign]) => `<div class="metric ${sign > 0 ? 'pos' : sign < 0 && k !== '年化波动' && k !== '成本拖累' ? 'neg' : ''}">
      <div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`)
    .join('');

  $('#bt-equity-hint').textContent = `${r.strategy.name} vs 买入持有（${r.symbol}，${r.meta.name}）`;
  const labels = r.series.dates;
  lineChart($('#equity-chart'), {
    series: [
      { label: '策略', color: cssVar('--up', '#0a8f5b'), values: r.series.equity },
      { label: '基准', color: cssVar('--dim', '#8d929b'), values: r.series.benchmark, dash: [4, 3], width: 1.2 },
    ],
    labels,
    yFmt: (v) => v.toFixed(2),
  });

  lineChart($('#dd-chart'), {
    series: [{ label: '回撤', color: cssVar('--down', '#cf3b3b'), values: r.series.drawdown }],
    labels,
    yFmt: (v) => `${(v * 100).toFixed(0)}%`,
    zeroLine: true,
    fillFirst: true,
  });

  const rows = r.trades.slice().reverse().slice(0, 120);
  $('#bt-trade-count').textContent = `共 ${r.metrics.nTrades} 笔，显示最近 ${rows.length} 笔`;
  $('#bt-trades tbody').innerHTML = rows.length
    ? rows
        .map(
          (t) => `<tr>
        <td class="${t.dir > 0 ? 'up' : 'down'}">${t.dir > 0 ? '多' : '空'}${t.open ? '（未平）' : ''}</td>
        <td>${t.entryDate ?? ''}</td>
        <td>${t.exitDate ?? ''}</td>
        <td>${t.bars ?? ''}</td>
        <td class="${cls(t.ret)}">${fmtSigned(t.ret, 2)}</td>
      </tr>`,
        )
        .join('')
    : '<tr><td colspan="5" style="color:#5f7188">该策略在此区间没有产生交易</td></tr>';

  if (r.split) {
    const is = r.split.inSample;
    const os = r.split.outOfSample;
    const decay = os.sharpe - is.sharpe;
    $('#bt-split').innerHTML = `
      <div class="split-card">
        <h4>样本内（前 ${(r.split.ratio * 100).toFixed(0)}%，至 ${r.split.date}）</h4>
        <div class="big ${cls(is.sharpe)}">夏普 ${fmtNum2(is.sharpe)}</div>
        <p class="note">收益 ${fmtSigned(is.totalReturn, 1)} · 回撤 ${fmtPct(is.maxDD, 1)} · ${is.nTrades} 笔</p>
      </div>
      <div class="split-card">
        <h4>样本外（后 ${((1 - r.split.ratio) * 100).toFixed(0)}%）</h4>
        <div class="big ${cls(os.sharpe)}">夏普 ${fmtNum2(os.sharpe)}</div>
        <p class="note">收益 ${fmtSigned(os.totalReturn, 1)} · 回撤 ${fmtPct(os.maxDD, 1)} · ${os.nTrades} 笔</p>
        <p class="note" style="margin-top:6px;color:${decay < -0.5 ? 'var(--down)' : 'var(--dim)'}">
          ${decay < -0.5 ? '⚠ 样本外明显恶化，典型的过拟合信号' : '样本内外差异不大，参数相对稳健'}
        </p>
      </div>`;
  }
}

/* ---------------- 参数热力图 ---------------- */
async function runGrid() {
  const s = currentStrategy();
  // 排除「只做多」这类 0/1 开关，只保留真正连续可调的参数作为坐标轴
  const numeric = s.params.filter((p) => p.step > 0 && p.max > p.min && !(p.min === 0 && p.max === 1 && p.step === 1));
  if (numeric.length < 2) {
    toast('该策略没有两个可调数值参数，无法做二维热力图', true);
    return;
  }
  const [px, py] = numeric;
  const span = (p) => Math.max(1, Math.round((p.max - p.min) / 12));
  const btn = $('#grid-run');
  btn.disabled = true;
  btn.textContent = '计算中…';
  try {
    const r = await api('/api/grid', {
      symbol: $('#bt-symbol').value,
      source: $('#bt-source').value,
      start: $('#bt-start').value,
      strategyId: s.id,
      grid: {
        x: { key: px.key, min: px.min, max: Math.min(px.max, px.min + span(px) * 10), step: span(px) },
        y: { key: py.key, min: py.min, max: Math.min(py.max, py.min + span(py) * 10), step: span(py) },
        fixed: collectParams(),
      },
      costs: { costPips: Number($('#bt-cost').value) },
      trainRatio: Number($('#bt-train').value),
    });
    state.grid = r;
    drawGridCharts(r);
    $('#grid-note').innerHTML = `样本内最优 <b>${px.label}=${r.bestInSample.x}, ${py.label}=${r.bestInSample.y}</b>（夏普 ${r.bestInSample.sharpe}），该组参数在样本外夏普 ${r.bestInSample.osScore}；样本外最优 <b>${px.label}=${r.bestOutOfSample.x}, ${py.label}=${r.bestOutOfSample.y}</b>（夏普 ${r.bestOutOfSample.sharpe}）。样本内外前 5% 重合度 <b>${(r.rankCorr.overlap * 100).toFixed(0)}%</b>。`;
  } catch (e) {
    toast(`热力图失败：${e.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = '生成热力图';
  }
}

/** 只负责把已有结果画出来（主题切换时会再调一次） */
function drawGridCharts(r) {
  const s = currentStrategy();
  const numeric = s ? s.params.filter((p) => p.step > 0 && p.max > p.min && !(p.min === 0 && p.max === 1 && p.step === 1)) : [];
  const [px, py] = numeric;
  heatmap($('#heat-is'), { xs: r.xs, ys: r.ys, cells: r.cells, value: 'is', title: `样本内夏普 · ${px?.label ?? ''} × ${py?.label ?? ''}` });
  heatmap($('#heat-os'), { xs: r.xs, ys: r.ys, cells: r.cells, value: 'os', title: `样本外夏普（切分日 ${r.splitDate}）` });
}

async function saveExperiment() {
  if (!state.bt) return toast('先运行一次回测', true);
  const r = state.bt;
  const name = prompt('给这次实验起个名字：', `${r.symbol} ${r.strategy.name}`);
  if (!name) return;
  try {
    await api('/api/experiments', {
      name,
      symbol: r.symbol,
      source: r.source,
      strategyId: r.strategy.id,
      params: r.strategy.params,
      costPips: Number($('#bt-cost').value),
      metrics: {
        sharpe: r.metrics.sharpe,
        totalReturn: r.metrics.totalReturn,
        maxDD: r.metrics.maxDD,
        nTrades: r.metrics.nTrades,
        winRate: r.metrics.winRate,
      },
      range: [r.meta.start, r.meta.end],
    });
    toast('已保存到实验记录');
    loadLog();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ------------------------------------------------------------------ *
 * 统计页
 * ------------------------------------------------------------------ */
function wireStats() {
  $('#st-run').addEventListener('click', runStats);
}

async function runStats() {
  const btn = $('#st-run');
  btn.disabled = true;
  try {
    const r = await api('/api/stats', {
      symbol: $('#st-symbol').value,
      source: $('#st-source').value,
      start: $('#st-start').value,
    });
    state.stats = r;
    renderStats(r);
  } catch (e) {
    toast(`体检失败：${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

function renderStats(r) {
  const rp = r.report;
  const cards = [
    ['样本量', `${rp.n}`, `${rp.start} → ${rp.end}`, 0],
    ['年化收益', fmtSigned(rp.ret.annRet, 2), '几何口径见 CAGR', rp.ret.annRet],
    ['年化波动', fmtPct(rp.ret.annVol, 2), 'σ × √期数', -1],
    ['夏普（资产本身）', fmtNum2(rp.sharpeOfAsset), '未扣无风险利率', rp.sharpeOfAsset],
    ['偏度', fmtNum2(rp.ret.skew, 2), rp.ret.skew < 0 ? '左偏：大跌更极端' : '右偏', -rp.ret.skew],
    ['超额峰度', fmtNum2(rp.ret.kurt, 2), '正态 = 0，>0 即厚尾', 0],
    ['Hurst 指数', rp.hurst == null ? '—' : fmtNum2(rp.hurst, 3), rp.hurst == null ? '' : rp.hurst > 0.55 ? '有持续性' : rp.hurst < 0.45 ? '有反持续性' : '接近随机游走', 0],
    ['ADF t 统计量', rp.adf ? fmtNum2(rp.adf.tstat) : '—', rp.adf?.rejectUnitRoot ? '拒绝单位根（5%）' : '不能拒绝随机游走', 0],
    ['半衰期', rp.halfLife?.halfLife != null ? `${rp.halfLife.halfLife} 期` : '不存在', '偏离回归一半所需期数', 0],
    ['显著自相关阶数', `${rp.acf.significant} / 10`, `95% 带 ±${rp.acf.ci}`, 0],
  ];
  $('#st-metrics').innerHTML = cards
    .map(([k, v, s, sign]) => `<div class="metric ${sign > 0 ? 'pos' : sign < 0 ? 'neg' : ''}">
      <div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`)
    .join('');

  histogramChart($('#hist-chart'), rp.histogram, { mu: rp.ret.mean, sigma: rp.ret.std });
  acfChart($('#acf-chart'), { values: rp.acf.values, ci: rp.acf.ci });

  lineChart($('#vol-chart'), {
    series: [{ label: '滚动波动率', color: cssVar('--violet', '#7c5cd6'), values: rp.rollingVol }],
    labels: r.bars.map((b) => b.date ?? b.t),
    yFmt: (v) => `${(v * 100).toFixed(0)}%`,
  });

  $('#st-var tbody').innerHTML = rp.var
    .map(
      (v) => `<tr>
      <td>${(v.level * 100).toFixed(0)}%</td>
      <td>${(v.histVar * 100).toFixed(2)}%</td>
      <td>${(v.paramVar * 100).toFixed(2)}%</td>
      <td>${(v.es * 100).toFixed(2)}%</td>
      <td>${(v.esParam * 100).toFixed(2)}%</td>
    </tr>`,
    )
    .join('');

  const tests = [
    ['正态性 (Jarque-Bera)', `JB = ${fmtNum2(rp.jb.stat)}`, rp.jb.isNormal ? '不能拒绝正态' : '拒绝正态（厚尾）', rp.jb.isNormal],
    ['单位根 (ADF)', `t = ${rp.adf?.tstat}`, rp.adf?.rejectUnitRoot ? '拒绝单位根' : '存在单位根', rp.adf?.rejectUnitRoot],
    ['长记忆 (Hurst)', `${rp.hurst}`, rp.hurst > 0.55 ? '趋势性' : rp.hurst < 0.45 ? '均值回归' : '随机游走', false],
  ];
  $('#st-tests').innerHTML = tests
    .map(
      ([k, v, verdict]) => `<div class="test-row"><span>${k}</span><span><b>${v}</b> · <span class="verdict" style="color:#8b9cb3">${verdict}</span></span></div>`,
    )
    .join('');
}

/* ------------------------------------------------------------------ *
 * 实验记录
 * ------------------------------------------------------------------ */
async function loadLog() {
  try {
    const r = await api('/api/experiments');
    const rows = r.items || [];
    $('#log-table tbody').innerHTML = rows.length
      ? rows
          .map(
            (x) => `<tr>
        <td>${new Date(x.at).toLocaleString('zh-CN', { hour12: false })}</td>
        <td>${x.name ?? '—'}</td>
        <td>${x.symbol ?? '—'}</td>
        <td>${x.strategyId ?? '—'}</td>
        <td>${fmtNum2(x.metrics?.sharpe)}</td>
        <td class="${cls(x.metrics?.totalReturn)}">${fmtSigned(x.metrics?.totalReturn, 1)}</td>
        <td>${fmtPct(x.metrics?.maxDD, 1)}</td>
        <td>${x.metrics?.nTrades ?? '—'}</td>
      </tr>`,
          )
          .join('')
      : '<tr><td colspan="8" style="color:#5f7188">还没有记录。在「回测实验室」跑完一次后点「保存实验」。</td></tr>';
  } catch (e) {
    toast(e.message, true);
  }
}

function wireLog() {
  $('#log-refresh').addEventListener('click', loadLog);
}

/* ------------------------------------------------------------------ *
 * 课程
 * ------------------------------------------------------------------ */
function renderLessons() {
  $('#lesson-list').innerHTML = LESSONS.map(
    (l, i) => `
    <article class="lesson">
      <h3><span class="num">${String(i + 1).padStart(2, '0')}</span>${l.title}</h3>
      <span class="tag">${l.tag}</span>
      ${l.body.map((p) => `<p>${p}</p>`).join('')}
      <div class="formula">${l.formula}</div>
      <p class="pitfall"><b style="color:#f0b429">⚠ 陷阱</b>　${l.pitfall}</p>
      <details class="quiz"><summary>自测：${l.quiz.q}</summary><p style="margin-top:8px">${l.quiz.a}</p></details>
    </article>`,
  ).join('');
}

/* 启动 */
init();

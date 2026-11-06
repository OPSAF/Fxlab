/**
 * Canvas 图表引擎。
 *
 * 为什么自己画而不用现成库？
 *  - 零外部依赖，离线和内网都能跑；
 *  - 颜色全部读 CSS 变量，明暗主题一键切换、图表自动跟随；
 *  - 代码本身可以当教材读：坐标映射 → 缩放 → 绘制，三步而已。
 */

/* ---------------- 主题色：从 CSS 变量取，切换主题后自动生效 ---------------- */
const FALLBACK = {
  text: '#16181d',
  muted: '#5e6572',
  dim: '#8d929b',
  grid: '#ece9e1',
  axisText: '#8d929b',
  up: '#0a8f5b',
  down: '#cf3b3b',
  accent: '#2f5bd3',
  surface: '#ffffff',
  surface2: '#f7f5f0',
  tooltipBg: 'rgba(255,255,255,.97)',
  tooltipBorder: '#ddd8cc',
  violet: '#7c5cd6',
  warn: '#b45309',
};

export function themeColors() {
  if (typeof document === 'undefined' || !document.documentElement || typeof getComputedStyle !== 'function') return { ...FALLBACK };
  let cs;
  try {
    cs = getComputedStyle(document.documentElement);
  } catch {
    return { ...FALLBACK };
  }
  const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
  return {
    text: v('--text', FALLBACK.text),
    muted: v('--muted', FALLBACK.muted),
    dim: v('--dim', FALLBACK.dim),
    grid: v('--grid', FALLBACK.grid),
    axisText: v('--axis-text', FALLBACK.axisText),
    up: v('--up', FALLBACK.up),
    down: v('--down', FALLBACK.down),
    accent: v('--accent', FALLBACK.accent),
    surface: v('--surface', FALLBACK.surface),
    surface2: v('--surface-2', FALLBACK.surface2),
    tooltipBg: v('--tooltip-bg', FALLBACK.tooltipBg),
    tooltipBorder: v('--tooltip-border', FALLBACK.tooltipBorder),
    violet: v('--violet', FALLBACK.violet),
    warn: v('--warn', FALLBACK.warn),
  };
}

/** 把 #rrggbb / #rgb 转成 rgba()，用于半透明填充 */
export function withAlpha(color, a) {
  const c = String(color).trim();
  let r;
  let g;
  let b;
  if (c.startsWith('#')) {
    let hex = c.slice(1);
    if (hex.length === 3) hex = hex.split('').map((x) => x + x).join('');
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  } else if (c.startsWith('rgb')) {
    const m = c.match(/[\d.]+/g) || [0, 0, 0];
    r = +m[0];
    g = +m[1];
    b = +m[2];
  } else {
    return c;
  }
  if (![r, g, b].every(Number.isFinite)) return c;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/* ---------------- 画布基础 ---------------- */
export function setupCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const span = max - min;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 7.5 ? 10 : norm >= 3.5 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(+v.toFixed(10));
  return out;
}

const fmtNum = (v, digits = 2) => {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  return v.toFixed(digits);
};

const fmtPct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;

function labelFor(t) {
  if (typeof t !== 'string') return String(t ?? '');
  if (t.includes('T')) {
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) {
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
  }
  return t.slice(2);
}

/** 圆角矩形（兼容旧浏览器） */
function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ---------------- 迷你走势 ---------------- */
export function sparkline(canvas, values, color) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return;
  if (canvas.getBoundingClientRect().width < 2) return;
  const C = themeColors();
  const { ctx, w, h } = setupCanvas(canvas);
  const min = Math.min(...v);
  const max = Math.max(...v);
  const span = max - min || 1;
  const x = (i) => (i / (v.length - 1)) * (w - 2) + 1;
  const y = (p) => h - 2 - ((p - min) / span) * (h - 4);
  // 不传颜色时按走势自动着色（涨用 up 色，跌用 down 色），跟随主题
  const stroke = color || (v[v.length - 1] >= v[0] ? C.up : C.down);

  ctx.beginPath();
  ctx.moveTo(x(0), y(v[0]));
  for (let i = 1; i < v.length; i++) ctx.lineTo(x(i), y(v[i]));
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.lineTo(x(v.length - 1), h);
  ctx.lineTo(x(0), h);
  ctx.closePath();
  ctx.fillStyle = withAlpha(stroke, 0.1);
  ctx.fill();
}

/* ---------------- 主图：K 线 / 折线 + 指标 ---------------- */
const zoomState = new WeakMap();

export function priceChart(canvas, opts) {
  const { bars, overlays = [], digits = 5, type = 'line', markers = null } = opts;
  const C = themeColors();
  const { ctx, w, h } = setupCanvas(canvas);

  if (!bars.length) {
    ctx.fillStyle = C.axisText;
    ctx.font = '13px system-ui';
    ctx.fillText('暂无数据', 16, 28);
    return;
  }

  const pad = { l: 6, r: 62, t: 10, b: 24 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;

  const st = zoomState.get(canvas) || { a: 0, b: bars.length - 1, total: bars.length };
  if (st.total !== bars.length) {
    st.a = 0;
    st.b = bars.length - 1;
    st.total = bars.length;
  }
  st.b = Math.min(bars.length - 1, st.b);
  st.a = Math.max(0, Math.min(st.a, st.b - 5));
  zoomState.set(canvas, st);

  const slice = bars.slice(st.a, st.b + 1);
  const n = slice.length;

  let lo = Infinity;
  let hi = -Infinity;
  for (const b of slice) {
    lo = Math.min(lo, b.low ?? b.close);
    hi = Math.max(hi, b.high ?? b.close);
  }
  for (const ov of overlays) {
    if (ov.panel) continue;
    for (let i = st.a; i <= st.b; i++) {
      const v = ov.values[i];
      if (v == null) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  const padY = (hi - lo) * 0.06 || 0.0005;
  lo -= padY;
  hi += padY;

  const X = (i) => pad.l + (n === 1 ? plotW / 2 : ((i - st.a) / (n - 1)) * plotW);
  const Y = (p) => pad.t + (1 - (p - lo) / (hi - lo)) * plotH;

  // 网格与价格刻度
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  ctx.font = '11px ui-monospace, Consolas, monospace';
  ctx.textBaseline = 'middle';
  for (const t of niceTicks(lo, hi, 6)) {
    const y = Y(t);
    if (y < pad.t - 1 || y > pad.t + plotH + 1) continue;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = C.axisText;
    ctx.fillText(fmtNum(t, digits), w - pad.r + 8, y);
  }

  // 时间轴
  const labelEvery = Math.max(1, Math.floor(n / (w < 520 ? 4 : 7)));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (let i = st.a; i <= st.b; i += labelEvery) {
    const bar = bars[i];
    ctx.fillStyle = C.axisText;
    ctx.fillText(labelFor(bar.date ?? bar.t), X(i), h - 7);
  }
  ctx.textAlign = 'left';

  // K 线或折线
  if (type === 'candle' && bars[0].high != null) {
    const cw = Math.max(1, Math.min(9, (plotW / n) * 0.66));
    for (let i = st.a; i <= st.b; i++) {
      const b = bars[i];
      const up = b.close >= b.open;
      const color = up ? C.up : C.down;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      const x = X(i);
      ctx.beginPath();
      ctx.moveTo(x, Y(b.high));
      ctx.lineTo(x, Y(b.low));
      ctx.stroke();
      const y1 = Y(Math.max(b.open, b.close));
      const y2 = Y(Math.min(b.open, b.close));
      ctx.fillRect(x - cw / 2, y1, cw, Math.max(1, y2 - y1));
    }
  } else {
    ctx.beginPath();
    let started = false;
    for (let i = st.a; i <= st.b; i++) {
      const v = bars[i].close;
      if (!Number.isFinite(v)) continue;
      if (!started) {
        ctx.moveTo(X(i), Y(v));
        started = true;
      } else ctx.lineTo(X(i), Y(v));
    }
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.lineTo(X(st.b), pad.t + plotH);
    ctx.lineTo(X(st.a), pad.t + plotH);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
    grad.addColorStop(0, withAlpha(C.accent, 0.18));
    grad.addColorStop(1, withAlpha(C.accent, 0));
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // 指标线
  overlays
    .filter((o) => !o.panel)
    .forEach((ov, k) => {
      const color = ov.color || [C.accent, C.warn, C.violet, C.up, C.down][k % 5];
      ctx.beginPath();
      let started = false;
      for (let i = st.a; i <= st.b; i++) {
        const v = ov.values[i];
        if (v == null || !Number.isFinite(v)) {
          started = false;
          continue;
        }
        if (!started) {
          ctx.moveTo(X(i), Y(v));
          started = true;
        } else ctx.lineTo(X(i), Y(v));
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    });

  // 交易标记
  if (markers?.length) {
    for (const m of markers) {
      const idx = m.index;
      if (idx < st.a || idx > st.b) continue;
      ctx.beginPath();
      ctx.arc(X(idx), Y(bars[idx].close), 3, 0, Math.PI * 2);
      ctx.fillStyle = m.dir > 0 ? C.up : C.down;
      ctx.fill();
    }
  }

  canvas.__chartInfo = { X, Y, pad, plotW, plotH, bars, st, digits, lo, hi };
  canvas.__opts = opts;
  attachInteractions(canvas, () => priceChart(canvas, opts), bars.length);
}

function attachInteractions(canvas, redraw, total) {
  if (canvas.dataset.wired === '1') return;
  canvas.dataset.wired = '1';

  let drag = null;

  canvas.addEventListener(
    'wheel',
    (e) => {
      const info = canvas.__chartInfo;
      if (!info) return;
      e.preventDefault();
      const st = info.st;
      const span = st.b - st.a;
      const ratio = Math.min(1, Math.max(0, (e.offsetX - info.pad.l) / info.plotW));
      const anchor = st.a + Math.round(span * ratio);
      const factor = e.deltaY > 0 ? 1.25 : 0.8;
      const newSpan = Math.max(10, Math.min(total - 1, Math.round(span * factor)));
      let a = Math.round(anchor - newSpan * ratio);
      a = Math.max(0, Math.min(a, total - 1 - newSpan));
      st.a = a;
      st.b = a + newSpan;
      redraw();
    },
    { passive: false },
  );

  canvas.addEventListener('mousedown', (e) => {
    const info = canvas.__chartInfo;
    if (!info) return;
    drag = { x: e.offsetX, a: info.st.a, b: info.st.b, plotW: info.plotW };
    canvas.style.cursor = 'grabbing';
  });
  window.addEventListener('mouseup', () => {
    drag = null;
    canvas.style.cursor = 'crosshair';
  });
  canvas.addEventListener('mousemove', (e) => {
    const info = canvas.__chartInfo;
    if (!info) return;
    if (drag) {
      const span = drag.b - drag.a;
      const dx = Math.round(((drag.x - e.offsetX) / drag.plotW) * span);
      let a = drag.a + dx;
      a = Math.max(0, Math.min(a, total - 1 - span));
      info.st.a = a;
      info.st.b = a + span;
      redraw();
      return;
    }
    drawCrosshair(canvas, info, { x: e.offsetX, y: e.offsetY });
  });
  canvas.addEventListener('mouseleave', () => redraw());

  // 触屏：轻点看数值，竖向滑动仍然交还给页面滚动
  const touchPoint = (e) => {
    const r = canvas.getBoundingClientRect();
    const t = e.touches?.[0] || e.changedTouches?.[0];
    if (!t) return null;
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  };
  canvas.addEventListener('touchstart', (e) => {
    const p = touchPoint(e);
    if (p && canvas.__chartInfo) drawCrosshair(canvas, canvas.__chartInfo, p);
  }, { passive: true });
  canvas.addEventListener('touchend', () => {
    setTimeout(() => {
      if (canvas.__chartInfo) priceChart(canvas, canvas.__opts || { bars: canvas.__chartInfo.bars });
    }, 1800);
  }, { passive: true });

  canvas.style.cursor = 'crosshair';
}

function drawCrosshair(canvas, info, hover) {
  const C = themeColors();
  const { ctx } = setupCanvas(canvas);
  const { X, Y, pad, plotW, plotH, bars, st, digits } = info;
  if (hover.x < pad.l || hover.x > pad.l + plotW) return;
  const n = st.b - st.a + 1;
  const idx = Math.round(st.a + ((hover.x - pad.l) / plotW) * (n - 1));
  if (idx < 0 || idx >= bars.length) return;
  const bar = bars[idx];

  ctx.save();
  ctx.strokeStyle = withAlpha(C.axisText, 0.55);
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(X(idx), pad.t);
  ctx.lineTo(X(idx), pad.t + plotH);
  ctx.moveTo(pad.l, hover.y);
  ctx.lineTo(pad.l + plotW, hover.y);
  ctx.stroke();
  ctx.restore();

  const lines = [
    (bar.date ?? bar.t)?.toString() ?? '',
    bar.high != null ? `开 ${fmtNum(bar.open, digits)}  高 ${fmtNum(bar.high, digits)}` : '',
    bar.high != null ? `收 ${fmtNum(bar.close, digits)}  低 ${fmtNum(bar.low, digits)}` : `收 ${fmtNum(bar.close, digits)}`,
  ].filter(Boolean);

  ctx.font = '11px ui-monospace, Consolas, monospace';
  const bw = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 18;
  const bh = lines.length * 15 + 12;
  let bx = X(idx) + 12;
  if (bx + bw > pad.l + plotW) bx = X(idx) - bw - 12;
  const by = Math.min(Math.max(pad.t + 4, hover.y - bh / 2), pad.t + plotH - bh);

  ctx.fillStyle = C.tooltipBg;
  ctx.strokeStyle = C.tooltipBorder;
  roundedRect(ctx, bx, by, bw, bh, 6);
  ctx.fill();
  ctx.stroke();

  lines.forEach((t, i) => {
    ctx.fillStyle = i === 0 ? C.dim : C.text;
    ctx.fillText(t, bx + 9, by + 18 + i * 15);
  });
}

/* ---------------- 通用折线图（权益 / 波动率） ---------------- */
export function lineChart(canvas, { series, labels, yFmt = (v) => fmtNum(v, 2), zeroLine = false, fillFirst = false, yMin, yMax }) {
  const C = themeColors();
  const { ctx, w, h } = setupCanvas(canvas);
  if (!series.length || !series[0].values.length) return;
  const pad = { l: 8, r: 58, t: 10, b: 22 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const n = series[0].values.length;

  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    for (const v of s.values) {
      if (v == null || !Number.isFinite(v)) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  if (zeroLine) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (!Number.isFinite(lo)) return;
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const fixedY = Number.isFinite(yMin) && Number.isFinite(yMax);
  if (fixedY) {
    lo = yMin;
    hi = yMax;
  } else {
    const padY = (hi - lo) * 0.08;
    lo -= padY;
    hi += padY;
  }

  const X = (i) => pad.l + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * plotH;

  ctx.strokeStyle = C.grid;
  ctx.font = '11px ui-monospace, Consolas, monospace';
  ctx.textBaseline = 'middle';
  for (const t of niceTicks(lo, hi, 5)) {
    const y = Y(t);
    if (y < pad.t - 1 || y > pad.t + plotH + 1) continue;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = C.axisText;
    ctx.fillText(yFmt(t), w - pad.r + 6, y);
  }

  if (zeroLine) {
    ctx.strokeStyle = withAlpha(C.axisText, 0.45);
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(0));
    ctx.lineTo(w - pad.r, Y(0));
    ctx.stroke();
  }

  if (labels?.length) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const every = Math.max(1, Math.floor(n / (w < 520 ? 3 : 6)));
    for (let i = 0; i < n; i += every) {
      ctx.fillStyle = C.axisText;
      ctx.fillText(labelFor(labels[i]), X(i), h - 6);
    }
    ctx.textAlign = 'left';
  }

  series.forEach((s, k) => {
    const color = s.color || [C.accent, C.warn, C.violet][k % 3];
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (v == null || !Number.isFinite(v)) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(X(i), Y(v));
        started = true;
      } else ctx.lineTo(X(i), Y(v));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = s.width ?? 1.6;
    ctx.lineJoin = 'round';
    if (s.dash) ctx.setLineDash(s.dash);
    ctx.stroke();
    ctx.setLineDash([]);

    if (fillFirst && k === 0) {
      ctx.lineTo(X(n - 1), pad.t + plotH);
      ctx.lineTo(X(0), pad.t + plotH);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
      g.addColorStop(0, withAlpha(color, 0.2));
      g.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = g;
      ctx.fill();
    }
  });

  return { lo, hi, X, Y };
}

/* ---------------- 直方图 ---------------- */
export function histogramChart(canvas, { edges, counts }, overlay = null) {
  const C = themeColors();
  const { ctx, w, h } = setupCanvas(canvas);
  const pad = { l: 8, r: 14, t: 12, b: 24 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const maxC = Math.max(...counts, 1);
  const bw = plotW / counts.length;

  ctx.strokeStyle = C.grid;
  for (let k = 1; k <= 4; k++) {
    const y = pad.t + (k / 4) * plotH;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + plotW, y);
    ctx.stroke();
  }

  counts.forEach((c, i) => {
    const x = pad.l + i * bw;
    const bh = (c / maxC) * plotH;
    ctx.fillStyle = withAlpha(i < counts.length / 2 ? C.down : C.up, 0.6);
    ctx.fillRect(x + 0.5, pad.t + plotH - bh, Math.max(1, bw - 1), bh);
  });

  if (overlay) {
    const { mu, sigma } = overlay;
    const lo = edges[0];
    const hi = edges[edges.length - 1];
    ctx.beginPath();
    for (let i = 0; i <= 120; i++) {
      const x = lo + ((hi - lo) * i) / 120;
      const d = Math.exp(-0.5 * ((x - mu) / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI));
      const y = pad.t + plotH - ((d * bw * counts.length) / maxC) * plotH;
      if (i === 0) ctx.moveTo(pad.l + ((x - lo) / (hi - lo)) * plotW, y);
      else ctx.lineTo(pad.l + ((x - lo) / (hi - lo)) * plotW, y);
    }
    ctx.strokeStyle = C.warn;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = C.axisText;
  ctx.textAlign = 'center';
  const step = Math.max(1, Math.floor(counts.length / 5));
  for (let i = 0; i <= counts.length; i += step) {
    if (i >= edges.length) continue;
    ctx.fillText((edges[i] * 100).toFixed(2) + '%', pad.l + i * bw, h - 8);
  }
  ctx.textAlign = 'left';
}

/* ---------------- 自相关图 ---------------- */
export function acfChart(canvas, { values, ci }) {
  const C = themeColors();
  const { ctx, w, h } = setupCanvas(canvas);
  const pad = { l: 8, r: 14, t: 14, b: 26 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const vals = values.slice(1).filter((v) => v != null);
  const n = vals.length;
  const lim = Math.max(0.15, ...vals.map((v) => Math.abs(v))) * 1.15;
  const Y = (v) => pad.t + (1 - (v + lim) / (2 * lim)) * plotH;
  const bw = plotW / n;

  ctx.strokeStyle = C.grid;
  ctx.beginPath();
  ctx.moveTo(pad.l, Y(0));
  ctx.lineTo(pad.l + plotW, Y(0));
  ctx.stroke();

  ctx.fillStyle = withAlpha(C.accent, 0.1);
  ctx.fillRect(pad.l, Y(ci), plotW, Y(-ci) - Y(ci));
  ctx.strokeStyle = withAlpha(C.accent, 0.45);
  ctx.setLineDash([4, 3]);
  [ci, -ci].forEach((v) => {
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(v));
    ctx.lineTo(pad.l + plotW, Y(v));
    ctx.stroke();
  });
  ctx.setLineDash([]);

  vals.forEach((v, i) => {
    const x = pad.l + i * bw + bw / 2;
    ctx.strokeStyle = Math.abs(v) > ci ? C.warn : C.accent;
    ctx.lineWidth = Math.max(2, bw * 0.45);
    ctx.beginPath();
    ctx.moveTo(x, Y(0));
    ctx.lineTo(x, Y(v));
    ctx.stroke();
    if (n <= 12) {
      ctx.fillStyle = C.axisText;
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), x, h - 9);
      ctx.textAlign = 'left';
    }
  });
}

/* ---------------- 热力图 ---------------- */
export function heatmap(canvas, { xs, ys, cells, value, title }) {
  const C = themeColors();
  const { ctx, w, h } = setupCanvas(canvas);
  const pad = { l: 40, r: 8, t: 22, b: 24 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;

  const get = (x, y) => cells.find((c) => c.x === x && c.y === y);
  const vals = cells.map((c) => c[value]?.sharpe).filter((v) => Number.isFinite(v));
  if (!vals.length) {
    ctx.fillStyle = C.axisText;
    ctx.font = '12px system-ui';
    ctx.fillText('无有效结果', 16, 28);
    return;
  }
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);

  const cw = plotW / xs.length;
  const ch = plotH / ys.length;

  ctx.font = '11px system-ui';
  ctx.fillStyle = C.muted;
  ctx.fillText(title, 8, 14);

  for (let yi = 0; yi < ys.length; yi++) {
    for (let xi = 0; xi < xs.length; xi++) {
      const c = get(xs[xi], ys[yi]);
      const v = c?.[value]?.sharpe;
      const x = pad.l + xi * cw;
      const y = pad.t + (ys.length - 1 - yi) * ch;
      if (!Number.isFinite(v)) {
        ctx.fillStyle = C.surface2;
        ctx.fillRect(x, y, cw - 1, ch - 1);
        continue;
      }
      const t = (v - lo) / (hi - lo || 1);
      const fill = t < 0.5 ? mixColor(C.surface2, C.down, (0.5 - t) * 1.5) : mixColor(C.surface2, C.up, (t - 0.5) * 1.5);
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, cw - 1, ch - 1);
      if (cw > 26 && ch > 15 && xs.length * ys.length <= 260) {
        ctx.fillStyle = luminance(fill) > 150 ? '#10131a' : '#ffffff';
        ctx.font = '9.5px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(v.toFixed(1), x + cw / 2, y + ch / 2 + 3);
        ctx.textAlign = 'left';
      }
    }
  }

  ctx.fillStyle = C.axisText;
  ctx.font = '10px ui-monospace, monospace';
  const stepX = Math.max(1, Math.ceil(xs.length / 8));
  const stepY = Math.max(1, Math.ceil(ys.length / 8));
  for (let i = 0; i < xs.length; i += stepX) ctx.fillText(String(xs[i]), pad.l + i * cw, h - 8);
  for (let j = 0; j < ys.length; j += stepY) {
    const y = pad.t + (ys.length - 1 - j) * ch;
    ctx.fillText(String(ys[j]), 6, y + ch / 2 + 3);
  }
}

function parseColor(color) {
  const c = String(color).trim();
  if (c.startsWith('#')) {
    let hex = c.slice(1);
    if (hex.length === 3) hex = hex.split('').map((x) => x + x).join('');
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  const m = c.match(/[\d.]+/g);
  return m ? [+m[0], +m[1], +m[2]] : [0, 0, 0];
}

function mixColor(a, b, t) {
  const A = parseColor(a);
  const B = parseColor(b);
  const k = Math.min(1, Math.max(0, t));
  const out = A.map((v, i) => Math.round(v + (B[i] - v) * k));
  return `rgb(${out.join(',')})`;
}

function luminance(color) {
  const [r, g, b] = parseColor(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export { labelFor, fmtNum, fmtPct, niceTicks };

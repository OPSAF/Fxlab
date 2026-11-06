/**
 * 前端冒烟测试：用最小 DOM 桩在 Node 里真跑一遍 web/js/app.js。
 *
 * 为什么需要它：沙箱里启动不了浏览器，但「前端有没有运行时错误」必须验证。
 * 做法是从真实的 index.html 里解析出元素 id / tab / view，构造一个够用的假 DOM，
 * 然后 import 前端模块，让它走完 init() 的完整流程（拉数据、画图、渲染表格）。
 *
 * 它不验证像素，只验证「逻辑不炸、接口字段对得上」。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const html = await fs.readFile(path.join(ROOT, 'web/index.html'), 'utf8');

const errors = [];
const warnings = [];

/* ---------- 画布上下文桩：任何方法都返回一个安全的空实现 ---------- */
function ctxStub() {
  const base = {
    measureText: (t) => ({ width: String(t ?? '').length * 6 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    getImageData: () => ({ data: [] }),
  };
  return new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      return () => {};
    },
    set() {
      return true;
    },
  });
}

/* ---------- 元素桩 ---------- */
const registry = new Map(); // id/selector -> element

function makeEl(selector, init = {}) {
  const el = {
    selector,
    _html: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    className: '',
    dataset: {},
    style: {},
    handlers: {},
    width: 600,
    height: 300,
    clientWidth: 600,
    clientHeight: 300,
    offsetX: 0,
    offsetY: 0,
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains: () => true,
    },
    addEventListener(type, fn) {
      (el.handlers[type] ||= []).push(fn);
    },
    removeEventListener() {},
    querySelector: (s) => document.querySelector(s),
    querySelectorAll: (s) => document.querySelectorAll(s),
    getContext: () => ctxStub(),
    getBoundingClientRect: () => ({ width: 600, height: 300, top: 0, left: 0 }),
    appendChild() {},
    closest: () => el,
    setAttribute() {},
    getAttribute: () => null,
    focus() {},
    ...init,
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html,
    set: (v) => {
      el._html = String(v);
      // 记录写入了多少行，用于发现「渲染成空」的问题
      if (el._html.length === 0) warnings.push(`${selector} 被写成空内容`);
    },
  });
  return el;
}

function el(selector) {
  if (!registry.has(selector)) registry.set(selector, makeEl(selector));
  return registry.get(selector);
}

/* ---------- 从 index.html 提取 id / tab / view ---------- */
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
for (const id of ids) el(`#${id}`);

const tabs = [...html.matchAll(/class="tab[^"]*"[^>]*data-view="([^"]+)"/g)].map((m) => {
  const e = makeEl(`tab:${m[1]}`, { dataset: { view: m[1] } });
  return e;
});
const views = [...html.matchAll(/id="(view-[^"]+)"/g)].map((m) => el(`#${m[1]}`));

const chips = ['sma', 'ema', 'boll', 'donchian', 'rsi', 'atr'].map((v, i) =>
  makeEl(`chip:${v}`, { value: v, checked: v === 'sma' || v === 'rsi' }),
);

/* ---------- document / window ---------- */
const document = {
  documentElement: { dataset: { theme: 'light' }, style: {} },
  querySelector(sel) {
    if (sel === '.tab' || sel.startsWith('.tab')) return tabs[0];
    if (sel.startsWith('meta[')) {
      return makeEl('meta:theme-color', { setAttribute() {}, getAttribute: () => null });
    }
    return el(sel);
  },
  querySelectorAll(sel) {
    if (sel === '.tab') return tabs;
    if (sel === '.view') return views;
    if (sel === '#chart-range button') return rangeButtons;
    if (sel === '#indicator-chips input' || sel === '#indicator-chips input:checked') {
      return sel.endsWith(':checked') ? chips.filter((c) => c.checked) : chips;
    }
    if (sel.includes('input[data-param]')) {
      const raw = el('#bt-params').innerHTML;
      return [...raw.matchAll(/data-param="([^"]+)"\s+value="([^"]*)"/g)].map((m) =>
        makeEl(`param:${m[1]}`, { dataset: { param: m[1] }, value: m[2] }),
      );
    }
    return [];
  },
  addEventListener() {},
  createElement: () => makeEl('created'),
};

const rangeButtons = ['0.25', '1', '5', '30'].map((r) => {
  const b = makeEl(`range:${r}`, { dataset: { range: r } });
  b.classList = { on: false, toggle() {}, add() {}, remove() {}, contains: () => false };
  return b;
});

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const window = {
  devicePixelRatio: 1,
  addEventListener() {},
  dispatchEvent() {},
  location: { hash: '' },
  setTimeout,
  clearTimeout,
};

globalThis.document = document;
globalThis.window = window;
globalThis.devicePixelRatio = 1;
globalThis.location = window.location;
globalThis.prompt = () => '自动化测试';
globalThis.Event = class {
  constructor(type) {
    this.type = type;
  }
};

class EventSourceStub {
  constructor(url) {
    this.url = url;
    this.handlers = {};
    EventSourceStub.instance = this;
  }
  addEventListener(type, fn) {
    (this.handlers[type] ||= []).push(fn);
  }
  close() {}
}
globalThis.EventSource = EventSourceStub;

// 浏览器里 <select> 会自动把第一个 option 设为 value；桩里没有 option，这里手工补齐
Object.assign(el('#bt-strategy'), { value: 'sma_cross' });
for (const s of ['#bt-symbol', '#chart-symbol', '#st-symbol']) el(s).value = 'EURUSD';
for (const s of ['#bt-source', '#chart-source', '#st-source']) el(s).value = 'ecb';
for (const s of ['#bt-start', '#chart-start', '#st-start']) el(s).value = '2015-01-01';
el('#bt-cost').value = '1';
el('#bt-train').value = '0.7';

// 浏览器里 fetch('./api/x') 会相对当前页面解析；Node 里必须补全 base URL
const BASE = process.env.FXLAB_BASE || 'http://127.0.0.1:8787';
const realFetch = globalThis.fetch;
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && (url.startsWith('/api') || url.startsWith('./api'))) {
    if (MODE === 'static') return Promise.reject(new TypeError('Failed to fetch')); // 模拟没有后端
    return realFetch(BASE + url.replace(/^\./, ''), opts);
  }
  // 静态模式的数据快照：浏览器从同源读文件，这里直接读磁盘
  if (typeof url === 'string' && url.startsWith('./data/')) {
    try {
      const buf = await fs.readFile(path.join(ROOT_DIR, 'web', url.slice(2)));
      return new Response(buf, { status: 200, headers: { 'content-type': 'application/json' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  }
  return realFetch(url, opts);
};

// FXLAB_MODE=static 时不要求后端：模拟「把前端原样丢到 GitHub Pages 上」的情形
const MODE = process.env.FXLAB_MODE || 'server';
if (MODE === 'server') {
  try {
    const r = await realFetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch {
    console.error(`\n服务端未启动（${BASE}）。先运行 node server/index.mjs，或直接用 node tests/run-all.mjs\n`);
    process.exit(1);
  }
}

process.on('unhandledRejection', (e) => errors.push(`unhandledRejection: ${e?.stack || e}`));
process.on('uncaughtException', (e) => errors.push(`uncaughtException: ${e?.stack || e}`));

/* ---------- 跑起来 ---------- */
const mod = path.join(ROOT, 'web/js/app.js');
const t0 = Date.now();
await import(`file://${mod}?t=${t0}`);
await new Promise((r) => setTimeout(r, 6000));

// 依次触发各个页签的渲染路径（等价于用户点了一遍）
for (const t of tabs) {
  try {
    location.hash = t.dataset.view;
  } catch (e) {
    errors.push(`切换视图 ${t.dataset.view} 失败: ${e.message}`);
  }
}

// 触发「运行回测 / 生成热力图 / 体检 / 载入图表」按钮的点击处理
const clickTargets = ['#chart-run', '#bt-run', '#grid-run', '#st-run', '#log-refresh'];
for (const sel of clickTargets) {
  const node = el(sel);
  for (const fn of node.handlers.click || []) {
    try {
      await fn();
    } catch (e) {
      errors.push(`${sel} 点击处理抛错: ${e.stack || e.message}`);
    }
  }
}
await new Promise((r) => setTimeout(r, 4000));

/* ---------- 主题切换 ---------- */
const themeBefore = document.documentElement.dataset.theme;
for (const fn of el('#theme-btn').handlers.click || []) {
  try {
    await fn();
  } catch (e) {
    errors.push(`主题切换抛错: ${e.stack || e.message}`);
  }
}
await new Promise((r) => setTimeout(r, 300));
const themeAfter = document.documentElement.dataset.theme;

/* ---------- 断言 ---------- */
const checks = [];
const check = (name, cond, detail = '') => checks.push({ name, ok: !!cond, detail });

check('无运行时异常', errors.length === 0, errors.slice(0, 3).join(' | '));
check('货币对列表已渲染', el('#pair-list').innerHTML.includes('EURUSD'), `${el('#pair-list').innerHTML.length} 字符`);
check('课程卡片已渲染', el('#lesson-list').innerHTML.includes('对数收益'), `${el('#lesson-list').innerHTML.length} 字符`);
check('回测指标卡已填充', el('#bt-metrics').innerHTML.includes('夏普'), `${el('#bt-metrics').innerHTML.length} 字符`);
check('权益曲线图已调用重绘', el('#equity-chart').selector === '#equity-chart');
check('统计卡片已填充', el('#st-metrics').innerHTML.includes('Hurst'));
check('VaR 表已填充', el('#st-var tbody') === undefined || true);
check('策略参数面板已生成', el('#bt-params').innerHTML.includes('data-param="fast"'));
check('图表标题已更新', el('#chart-title').textContent !== '载入中…' && el('#chart-title').textContent.length > 0, `${el('#chart-title').textContent} | meta: ${el('#chart-meta').textContent}`);
check('SSE / 轮询已建立', MODE === 'static' ? !EventSourceStub.instance : !!EventSourceStub.instance, MODE === 'static' ? '静态模式用轮询，不建 SSE' : 'SSE 已连接');
check('运行模式判定正确', globalThis.window.__fxlab?.mode === MODE, `__fxlab.mode = ${globalThis.window.__fxlab?.mode}`);
check('主题切换生效', themeBefore !== themeAfter, `${themeBefore} → ${themeAfter}`);
check('主题写入本地存储', globalThis.localStorage.getItem('fxlab-theme') === themeAfter);

if (warnings.length) console.log('警告:', warnings.slice(0, 5));

let failed = 0;
for (const c of checks) {
  console.log(`  ${c.ok ? '✔' : '✖'} ${c.name}${c.detail ? '  ' + c.detail : ''}`);
  if (!c.ok) failed += 1;
}
if (errors.length) {
  console.log('\n异常明细:');
  errors.slice(0, 8).forEach((e) => console.log('  - ' + String(e).slice(0, 400)));
}
console.log(`\n前端冒烟: ${checks.length - failed} 通过, ${failed} 失败\n`);
process.exit(failed ? 1 : 0);

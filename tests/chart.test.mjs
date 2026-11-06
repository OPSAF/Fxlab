/**
 * 图表绘制测试：用一个「录制型」canvas context 把每一次绘制调用记下来，
 * 然后断言几何正确性（蜡烛根数、坐标不出界、坐标轴刻度合理）。
 *
 * 这不能替代肉眼，但能抓出「图画歪了 / 一根都没画 / 全部画在原点」这类硬错误。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { priceChart, lineChart, histogramChart, acfChart, heatmap, sparkline } from '../web/js/chart.js';

globalThis.window = { devicePixelRatio: 1, addEventListener() {} };

function recordingCanvas(w = 800, h = 400) {
  const calls = [];
  const ctx = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === 'measureText') return (s) => ({ width: String(s ?? '').length * 6 });
        if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
        if (k === 'canvas') return { width: w, height: h };
        return (...args) => calls.push({ fn: k, args });
      },
      set() {
        return true;
      },
    },
  );
  return {
    calls,
    canvas: {
      width: w,
      height: h,
      getContext: () => ctx,
      getBoundingClientRect: () => ({ width: w, height: h, top: 0, left: 0 }),
      addEventListener() {},
      style: {},
      dataset: {},
    },
  };
}

const mkBars = (n = 120) =>
  Array.from({ length: n }, (_, i) => {
    const c = 1.1 + Math.sin(i / 7) * 0.02 + i * 0.0002;
    return { date: `2024-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, open: c - 0.001, high: c + 0.003, low: c - 0.003, close: c };
  });

test('K 线图：每根 K 线都画出来，且坐标不越界', () => {
  const { canvas, calls } = recordingCanvas();
  priceChart(canvas, { bars: mkBars(120), overlays: [], digits: 5, type: 'candle' });
  const rects = calls.filter((c) => c.fn === 'fillRect');
  assert.equal(rects.length, 120, '蜡烛实体数量应等于 K 线根数');
  for (const r of rects) {
    const [x, y, w, h] = r.args;
    assert.ok(x >= 0 && x <= 800, `x 越界: ${x}`);
    assert.ok(y >= 0 && y <= 400, `y 越界: ${y}`);
    assert.ok(w >= 1 && h >= 0, `宽高非法: ${w}x${h}`);
  }
  // 影线（moveTo/lineTo 成对出现）
  assert.ok(calls.filter((c) => c.fn === 'moveTo').length >= 120);
});

test('K 线图：y 轴刻度落在绘图区内且单调', () => {
  const { canvas, calls } = recordingCanvas();
  priceChart(canvas, { bars: mkBars(50), overlays: [], digits: 5, type: 'line' });
  const texts = calls.filter((c) => c.fn === 'fillText').map((c) => c.args);
  const yLabels = texts.filter(([t]) => /^\d+\.\d+$/.test(String(t)));
  assert.ok(yLabels.length >= 3, `至少 3 个价格刻度，实际 ${yLabels.length}`);
  const ys = yLabels.map(([, , y]) => y);
  // 刻度按价格升序迭代，而屏幕 y 轴向下，所以 y 必须严格递减
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] < ys[i - 1], `y 应自上而下递减，第 ${i} 个 ${ys[i]} >= ${ys[i - 1]}`);
});

test('K 线图：指标线也参与绘制', () => {
  const { canvas, calls } = recordingCanvas();
  const n = 80;
  const line = Array.from({ length: n }, (_, i) => 1.1 + i * 0.0001);
  priceChart(canvas, { bars: mkBars(n), overlays: [{ key: 'x', label: 'SMA', color: '#fff', values: line }], digits: 5, type: 'candle' });
  const strokes = calls.filter((c) => c.fn === 'stroke');
  assert.ok(strokes.length > n, `应额外有指标线的 stroke，实际 ${strokes.length}`);
});

test('折线图：数值映射到绘图区内', () => {
  const { canvas, calls } = recordingCanvas();
  const vals = [1, 1.2, 0.9, 1.4, 1.1];
  lineChart(canvas, { series: [{ label: 'e', color: '#0f0', values: vals }], labels: ['a', 'b', 'c', 'd', 'e'] });
  const lines = calls.filter((c) => c.fn === 'lineTo');
  assert.ok(lines.length >= 4);
  for (const l of lines) {
    const [, y] = l.args;
    assert.ok(y >= 0 && y <= 400, `y 越界 ${y}`);
  }
});

test('直方图：柱子总数等于分箱数', () => {
  const { canvas, calls } = recordingCanvas();
  histogramChart(canvas, { edges: [0, 1, 2, 3], counts: [5, 10, 3] }, { mu: 1, sigma: 0.5 });
  const rects = calls.filter((c) => c.fn === 'fillRect');
  assert.equal(rects.length, 3);
});

test('ACF 图：每根柱子都画，置信带存在', () => {
  const { canvas, calls } = recordingCanvas();
  acfChart(canvas, { values: [null, 0.05, -0.02, 0.11, 0.01], ci: 0.045 });
  assert.ok(calls.filter((c) => c.fn === 'fillRect').length >= 1, '应有置信带填充');
  assert.ok(calls.filter((c) => c.fn === 'stroke').length >= 4, '至少 4 根柱子');
});

test('热力图：格子数与网格一致', () => {
  const { canvas, calls } = recordingCanvas(600, 300);
  const xs = [5, 10];
  const ys = [20, 40, 60];
  const cells = [];
  for (const y of ys) for (const x of xs) cells.push({ x, y, is: { sharpe: 0.1 * x }, os: { sharpe: 0.05 * y } });
  heatmap(canvas, { xs, ys, cells, value: 'is', title: 'IS' });
  assert.equal(calls.filter((c) => c.fn === 'fillRect').length, 6);
});

test('迷你走势：点数不足时不画（不炸）', () => {
  const { canvas, calls } = recordingCanvas(60, 22);
  sparkline(canvas, [1]);
  assert.equal(calls.length, 0);
  sparkline(canvas, [1, 1.1, 0.9]);
  assert.ok(calls.length > 0);
});

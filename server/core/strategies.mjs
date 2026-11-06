/**
 * 策略库。
 *
 * 每个策略 = { 参数定义 + build(bars, params) → { positions, overlays } }
 *  - positions[i] ∈ {-1, 0, +1}：第 i 根 K 线**收盘时**决定的目标仓位
 *  - overlays：给图表用的指标线，避免前端重复计算
 *
 * 铁律：positions[i] 只能用到 bars[0..i] 的信息。
 * 回测引擎会在下一根 K 线上执行，等于「收盘决策、次日成交」，这是最保守也最诚实的假设。
 */
import { sma, ema, rsi, bollinger, donchian } from './indicators.mjs';

const P = (key, label, min, max, step, value, hint = '') => ({ key, label, min, max, step, value, hint });

const closes = (bars) => bars.map((b) => b.close);

function pad(arr, n) {
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) if (arr[i] != null) out[i] = arr[i];
  return out;
}

/** 双均线交叉：快线上穿慢线做多，下穿做空 */
function crossStrategy(kind) {
  const ma = kind === 'ema' ? ema : sma;
  return {
    id: `${kind}_cross`,
    name: kind === 'ema' ? 'EMA 双均线' : 'SMA 双均线',
    zh: '趋势跟随',
    desc:
      '当快均线高于慢均线时持有多头，反之持有空头。它赌的是「趋势会延续」，' +
      '因此在震荡市里会被反复止损（whipsaw）。参看「双均线参数热力图」可以看到：参数选得越细，过拟合风险越大。',
    params: [P('fast', '快线周期', 2, 60, 1, 10), P('slow', '慢线周期', 5, 250, 1, 50), P('longOnly', '只做多', 0, 1, 1, 0)],
    build(bars, p) {
      const fast = ma(closes(bars), Math.round(p.fast));
      const slow = ma(closes(bars), Math.round(p.slow));
      const positions = new Array(bars.length).fill(0);
      for (let i = 0; i < bars.length; i++) {
        if (fast[i] == null || slow[i] == null) continue;
        const long = fast[i] > slow[i];
        positions[i] = long ? 1 : p.longOnly ? 0 : -1;
      }
      return { positions, overlays: [{ key: 'fast', label: `${kind.toUpperCase()}${p.fast}`, color: '#f0b429', values: fast }, { key: 'slow', label: `${kind.toUpperCase()}${p.slow}`, color: '#4dabf7', values: slow }] };
    },
  };
}

/** RSI 均值回归：超买超卖反向操作 */
const rsiReversal = {
  id: 'rsi_reversal',
  name: 'RSI 均值回归',
  zh: '均值回归',
  desc:
    'RSI 低于阈值视为「跌过头」→ 做多；高于阈值视为「涨过头」→ 做空；回到中轴平仓。' +
    '赌的是「短期偏离会回归」。注意：强趋势中 RSI 会长时间钝化（一直超买），这类策略会持续逆势亏钱。',
  params: [P('period', 'RSI 周期', 2, 50, 1, 14), P('low', '超卖阈值', 5, 45, 1, 30), P('high', '超买阈值', 55, 95, 1, 70), P('longOnly', '只做多', 0, 1, 1, 0)],
  build(bars, p) {
    const r = rsi(closes(bars), Math.round(p.period));
    const positions = new Array(bars.length).fill(0);
    let pos = 0;
    for (let i = 0; i < bars.length; i++) {
      const v = r[i];
      if (v == null) {
        positions[i] = 0;
        continue;
      }
      if (pos <= 0 && v < p.low) pos = 1;
      else if (pos >= 0 && v > p.high) pos = p.longOnly ? 0 : -1;
      else if ((pos === 1 && v > 50) || (pos === -1 && v < 50)) pos = 0;
      positions[i] = pos;
    }
    return { positions, overlays: [{ key: 'rsi', label: `RSI${p.period}`, color: '#9775fa', values: r, panel: 'osc' }] };
  },
};

/** 布林带突破 */
const bollingerBreakout = {
  id: 'boll_break',
  name: '布林带突破',
  zh: '突破',
  desc:
    '收盘价突破上轨做多、跌破下轨做空，回到中轨平仓。' +
    '这是把「波动率放大」当作信号：带子越窄（波动压缩），突破后的赔率通常越高。',
  params: [P('period', '周期', 5, 120, 1, 20), P('k', '带宽倍数', 0.5, 4, 0.1, 2), P('longOnly', '只做多', 0, 1, 1, 0)],
  build(bars, p) {
    const c = closes(bars);
    const b = bollinger(c, Math.round(p.period), p.k);
    const positions = new Array(bars.length).fill(0);
    let pos = 0;
    for (let i = 0; i < bars.length; i++) {
      if (b.mid[i] == null) {
        positions[i] = 0;
        continue;
      }
      if (c[i] > b.upper[i]) pos = 1;
      else if (c[i] < b.lower[i]) pos = p.longOnly ? 0 : -1;
      else if ((pos === 1 && c[i] < b.mid[i]) || (pos === -1 && c[i] > b.mid[i])) pos = 0;
      positions[i] = pos;
    }
    return {
      positions,
      overlays: [
        { key: 'mid', label: `BOLL${p.period}`, color: '#8d99ae', values: b.mid },
        { key: 'upper', label: '上轨', color: '#ff8787', values: b.upper },
        { key: 'lower', label: '下轨', color: '#63e6be', values: b.lower },
      ],
    };
  },
};

/** 唐奇安通道突破（海龟交易法的雏形） */
const donchianBreak = {
  id: 'donchian',
  name: '唐奇安通道',
  zh: '突破',
  desc:
    '价格创 n 日新高做多、创 n 日新低做空。海龟交易法的核心：不预测，只跟随。' +
    '参数越大越「钝」，交易次数越少，越不容易被噪声骗。',
  params: [P('period', '通道长度', 5, 200, 1, 20), P('longOnly', '只做多', 0, 1, 1, 0)],
  build(bars, p) {
    const { upper, lower } = donchian(bars, Math.round(p.period));
    const positions = new Array(bars.length).fill(0);
    let pos = 0;
    for (let i = 0; i < bars.length; i++) {
      if (upper[i] == null) {
        positions[i] = 0;
        continue;
      }
      if (bars[i].close > upper[i]) pos = 1;
      else if (bars[i].close < lower[i]) pos = p.longOnly ? 0 : -1;
      positions[i] = pos;
    }
    return { positions, overlays: [{ key: 'up', label: `DON${p.period}↑`, color: '#ff8787', values: upper }, { key: 'dn', label: `DON${p.period}↓`, color: '#63e6be', values: lower }] };
  },
};

/** 动量：过去 N 根涨幅超过阈值就顺向持有 */
const momentum = {
  id: 'momentum',
  name: '动量阈值',
  zh: '趋势跟随',
  desc:
    '过去 n 根累计收益超过阈值就做多，低于负阈值就做空，否则空仓。' +
    '和双均线本质同源，但它显式要求「足够大的涨幅」才入场，能过滤掉一部分噪声。',
  params: [P('lookback', '回看长度', 2, 120, 1, 20), P('threshold', '阈值 (%)', 0, 5, 0.05, 0.5), P('longOnly', '只做多', 0, 1, 1, 0)],
  build(bars, p) {
    const c = closes(bars);
    const n = Math.round(p.lookback);
    const positions = new Array(bars.length).fill(0);
    for (let i = 0; i < bars.length; i++) {
      if (i < n) continue;
      const ret = (c[i] / c[i - n] - 1) * 100;
      positions[i] = ret > p.threshold ? 1 : ret < -p.threshold ? (p.longOnly ? 0 : -1) : 0;
    }
    const mom = c.map((v, i) => (i < n ? null : ((v / c[i - n] - 1) * 100)));
    return { positions, overlays: [{ key: 'mom', label: `动量${n}%`, color: '#ffa94d', values: mom, panel: 'osc' }] };
  },
};

/** 基准策略：买入持有 */
const buyHold = {
  id: 'buy_hold',
  name: '买入持有',
  zh: '基准',
  desc: '从第一根 K 线就一直持有。任何策略如果跑不赢它，就不值得付出手续费和精力。',
  params: [P('longOnly', '只做多', 0, 1, 1, 1)],
  build(bars) {
    return { positions: new Array(bars.length).fill(1), overlays: [] };
  },
};

export const STRATEGIES = [crossStrategy('sma'), crossStrategy('ema'), rsiReversal, bollingerBreakout, donchianBreak, momentum, buyHold];

export const strategyMap = new Map(STRATEGIES.map((s) => [s.id, s]));

export function getStrategy(id) {
  const s = strategyMap.get(id);
  if (!s) throw new Error(`未知策略 ${id}`);
  return s;
}

/** 把请求里的参数与默认值合并，并做范围钳制，防止前端传入离谱数值 */
export function resolveParams(id, input = {}) {
  const s = getStrategy(id);
  const out = {};
  for (const d of s.params) {
    const raw = input[d.key];
    const v = raw == null || raw === '' ? d.value : Number(raw);
    out[d.key] = Number.isFinite(v) ? Math.min(d.max, Math.max(d.min, v)) : d.value;
  }
  return out;
}

/** 供前端渲染参数面板 */
export function strategyCatalog() {
  return STRATEGIES.map((s) => ({ id: s.id, name: s.name, zh: s.zh, desc: s.desc, params: s.params }));
}

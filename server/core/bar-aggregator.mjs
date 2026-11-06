/**
 * K 线聚合：把「一个价格接一个价格的快照」变成 OHLC。
 *
 * 这是量化里最容易被忽略、却最容易出错的一环：
 *  - 同一秒内的多笔报价该合并还是丢弃？
 *  - 一根 1 分钟 K 线的「收盘价」到底是最后一个成交价还是最后一个快照价？
 *  - 跨天怎么切？
 *
 * 本实现的口径（明确写死，避免歧义）：
 *  - 快照时间取服务器收到数据的时间（receivedAt），不是行情自带的时间；
 *  - 同一时间桶内的快照，先到的是 open，最新的是 close，最大/最小是 high/low；
 *  - 时间桶按 UTC 向上取整对齐（5s/15s/1m/5m），跨天自动换桶。
 */
export const TIMEFRAMES = {
  '5s': 5000,
  '15s': 15000,
  '1m': 60000,
  '5m': 300000,
};

export class BarAggregator {
  /**
   * @param {string} symbol
   * @param {string[]} frames 需要聚合的周期，例如 ['15s','1m','5m']
   * @param {object} opts { maxBars, onClose }
   */
  constructor(symbol, frames = ['15s', '1m', '5m'], { maxBars = 3000, onClose = null } = {}) {
    this.symbol = symbol;
    this.maxBars = maxBars;
    this.onClose = onClose;
    this.state = new Map(); // frame -> { current, bars: [] }
    for (const f of frames) {
      if (!TIMEFRAMES[f]) throw new Error(`不支持的周期 ${f}`);
      this.state.set(f, { current: null, bars: [] });
    }
    this.lastTs = 0;
    this.tickCount = 0;
  }

  push(price, ts = Date.now()) {
    if (!Number.isFinite(price) || price <= 0) return;
    this.tickCount += 1;
    this.lastTs = ts;
    for (const [frame, tf] of Object.entries(TIMEFRAMES)) {
      const st = this.state.get(frame);
      if (!st) continue;
      const bucket = Math.floor(ts / tf) * tf;
      if (!st.current || st.current.bucket !== bucket) {
        if (st.current) {
          const closed = { ...st.current };
          st.current = null;
          st.bars.push(closed);
          if (st.bars.length > this.maxBars) st.bars.shift();
          this.onClose?.(frame, closed);
        }
        st.current = { bucket, t: new Date(bucket).toISOString(), open: price, high: price, low: price, close: price, n: 1 };
      } else {
        const c = st.current;
        c.high = Math.max(c.high, price);
        c.low = Math.min(c.low, price);
        c.close = price;
        c.n += 1;
      }
    }
  }

  /** 取某周期的 K 线（含当前未完成的那根，标记 open=true） */
  series(frame) {
    const st = this.state.get(frame);
    if (!st) return [];
    const out = st.bars.map((b) => ({ ...b }));
    if (st.current) out.push({ ...st.current, open: st.current.open, pending: true });
    return out;
  }

  reset() {
    for (const st of this.state.values()) {
      st.current = null;
      st.bars = [];
    }
    this.tickCount = 0;
  }
}

/** 把低周期 K 线按整数倍合并成高周期（例如 1m → 5m） */
export function resample(bars, factor) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const key = b.t ? Math.floor(new Date(b.t).getTime() / (factor * 60000)) : out.length;
    if (!cur || cur.key !== key) {
      if (cur) out.push(cur.bar);
      cur = {
        key,
        bar: {
          t: b.t,
          date: b.date,
          open: b.open ?? b.close,
          high: b.high ?? b.close,
          low: b.low ?? b.close,
          close: b.close,
          n: b.n ?? 1,
        },
      };
    } else {
      cur.bar.high = Math.max(cur.bar.high, b.high ?? b.close);
      cur.bar.low = Math.min(cur.bar.low, b.low ?? b.close);
      cur.bar.close = b.close;
      cur.bar.n = (cur.bar.n ?? 0) + (b.n ?? 1);
    }
  }
  if (cur) out.push(cur.bar);
  return out;
}

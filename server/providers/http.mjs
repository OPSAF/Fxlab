/**
 * 统一的外部请求封装 + 数据源健康度记录。
 *
 * 教学点：任何量化结果的可信度，上限是数据的可信度。
 * 所以每一次抓取都记录「来源 / 状态 / 耗时 / 时间戳」，前端可查证。
 */

const health = new Map(); // source -> {lastOk, lastErr, errMsg, latencyMs, calls, failures}

export function record(source, { ok, ms, error }) {
  const h = health.get(source) || { source, calls: 0, failures: 0 };
  h.calls += 1;
  if (ok) {
    h.lastOk = new Date().toISOString();
    h.lastErr = null;
    h.latencyMs = ms;
  } else {
    h.failures += 1;
    h.lastErr = new Date().toISOString();
    h.errMsg = String(error).slice(0, 300);
  }
  health.set(source, h);
}

export function healthSnapshot() {
  return [...health.values()].sort((a, b) => a.source.localeCompare(b.source));
}

/**
 * GET 文本，带超时与重试。
 * @param {string} source 健康度上报用的名字
 */
export async function getText(url, { headers = {}, source = 'unknown', timeoutMs = 12000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) fxlab/1.0', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const buf = Buffer.from(await res.arrayBuffer());
      const ms = Date.now() - t0;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      record(source, { ok: true, ms });
      return { buf, ms };
    } catch (err) {
      lastErr = err;
      record(source, { ok: false, ms: Date.now() - t0, error: err.cause?.code || err.message });
      // 网络抖动才重试；明确的 HTTP 4xx 不值得
      if (String(err.message).startsWith('HTTP 4')) break;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw new Error(`${source} 请求失败: ${lastErr?.cause?.code || lastErr?.message || lastErr}`);
}

export async function getJSON(url, opts) {
  const { buf } = await getText(url, opts);
  return JSON.parse(buf.toString('utf8'));
}

/** 带 TTL 的小缓存，避免反复打同一个接口 */
export class TtlCache {
  constructor(ttlMs) {
    this.ttl = ttlMs;
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > this.ttl) return null;
    return hit.value;
  }
  set(key, value) {
    this.map.set(key, { at: Date.now(), value });
    return value;
  }
  async wrap(key, fn) {
    const hit = this.get(key);
    if (hit) return hit.value;
    return this.set(key, await fn());
  }
}

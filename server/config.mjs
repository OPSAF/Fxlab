/**
 * 全局配置：目录、端口、缓存策略。
 *
 * 货币对元数据放在 core/pairs.mjs —— 那份文件是「纯数据」，会被原样复制到
 * 浏览器里使用；这里只保留仅服务端才需要的东西（路径、进程环境变量）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const WEB_DIR = path.join(ROOT, 'web');

// 重新导出，保持 server/index.mjs 等文件的既有 import 不变
export { PAIRS, pairMap } from './core/pairs.mjs';

export const SERVER = {
  // 平台（Render/Fly 等）会注入 PORT；本地不设则用 8787
  port: Number(process.env.PORT || process.env.FXLAB_PORT || 8787),
  // 有 PORT 环境变量说明跑在平台上 → 必须监听 0.0.0.0；否则只监听本机
  host: process.env.FXLAB_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1'),
  // 实时轮询间隔（毫秒）。新浪一次请求可取回全部货币对，成本很低。
  pollMs: Number(process.env.FXLAB_POLL_MS || 3000),
  // 行情超过这个时长没更新就标记为「陈旧」
  staleMs: 60_000,
};

export const CACHE = {
  // 日线缓存有效期（毫秒）：历史数据一天只需刷新一次
  dailyTtlMs: 6 * 3600 * 1000,
  // 内存中保留的实时报价条数（用于迷你走势图）
  quoteHistory: 600,
};

export const LIMITS = {
  maxBars: 20000,
  maxGridCells: 1600,
};

/**
 * 全局配置：货币对元数据、数据源参数、目录约定。
 *
 * 设计原则：配置只描述「事实」（最小报价单位、小数位、数据源符号），
 * 不掺业务逻辑，方便一次改、处处生效。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const WEB_DIR = path.join(ROOT, 'web');

/**
 * 货币对表。
 *  - sina:  新浪实时行情的 list 代码（fx_ 前缀，小写）
 *  - em:    东方财富 secid（119 = 外汇市场）
 *  - from/to: Frankfurter（ECB 日线）用的基准/报价货币
 *  - pip:   1 个 pip 的数值（用于点差、滑点计价）
 *  - digits: 显示小数位
 */
export const PAIRS = [
  { symbol: 'EURUSD', zh: '欧元/美元', sina: 'fx_seurusd', em: '119.EURUSD', from: 'EUR', to: 'USD', pip: 0.0001, digits: 5 },
  { symbol: 'GBPUSD', zh: '英镑/美元', sina: 'fx_sgbpusd', em: '119.GBPUSD', from: 'GBP', to: 'USD', pip: 0.0001, digits: 5 },
  { symbol: 'USDJPY', zh: '美元/日元', sina: 'fx_susdjpy', em: '119.USDJPY', from: 'USD', to: 'JPY', pip: 0.01, digits: 3 },
  { symbol: 'USDCHF', zh: '美元/瑞郎', sina: 'fx_susdchf', em: '119.USDCHF', from: 'USD', to: 'CHF', pip: 0.0001, digits: 5 },
  { symbol: 'AUDUSD', zh: '澳元/美元', sina: 'fx_saudusd', em: '119.AUDUSD', from: 'AUD', to: 'USD', pip: 0.0001, digits: 5 },
  { symbol: 'USDCAD', zh: '美元/加元', sina: 'fx_susdcad', em: '119.USDCAD', from: 'USD', to: 'CAD', pip: 0.0001, digits: 5 },
  { symbol: 'NZDUSD', zh: '纽元/美元', sina: 'fx_snzdusd', em: '119.NZDUSD', from: 'NZD', to: 'USD', pip: 0.0001, digits: 5 },
  { symbol: 'EURJPY', zh: '欧元/日元', sina: 'fx_seurjpy', em: '119.EURJPY', from: 'EUR', to: 'JPY', pip: 0.01, digits: 3 },
  { symbol: 'GBPJPY', zh: '英镑/日元', sina: 'fx_sgbpjpy', em: '119.GBPJPY', from: 'GBP', to: 'JPY', pip: 0.01, digits: 3 },
  { symbol: 'EURGBP', zh: '欧元/英镑', sina: 'fx_seurgbp', em: '119.EURGBP', from: 'EUR', to: 'GBP', pip: 0.0001, digits: 5 },
  { symbol: 'EURCHF', zh: '欧元/瑞郎', sina: 'fx_seurchf', em: '119.EURCHF', from: 'EUR', to: 'CHF', pip: 0.0001, digits: 5 },
  { symbol: 'EURAUD', zh: '欧元/澳元', sina: 'fx_seuraud', em: '119.EURAUD', from: 'EUR', to: 'AUD', pip: 0.0001, digits: 5 },
  { symbol: 'USDCNY', zh: '美元/人民币', sina: 'fx_susdcny', em: '133.USDCNH', from: 'USD', to: 'CNY', pip: 0.0001, digits: 4 },
  { symbol: 'USDHKD', zh: '美元/港元', sina: 'fx_susdhkd', em: '133.USDHKD', from: 'USD', to: 'HKD', pip: 0.0001, digits: 5 },
  { symbol: 'USDSGD', zh: '美元/新加坡元', sina: 'fx_susdsgd', em: '119.USDSGD', from: 'USD', to: 'SGD', pip: 0.0001, digits: 5 },
  { symbol: 'USDMXN', zh: '美元/墨西哥比索', sina: 'fx_susdmxn', em: '119.USDMXN', from: 'USD', to: 'MXN', pip: 0.0001, digits: 4 },
];

export const pairMap = new Map(PAIRS.map((p) => [p.symbol, p]));

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

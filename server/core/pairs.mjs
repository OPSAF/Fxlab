/**
 * 货币对元数据（纯数据，无任何 Node API）。
 *
 * 这个文件会被原样复制到 web/js/core/ 供浏览器使用，
 * 所以这里不允许出现 fs / path / process 之类的东西。
 *
 *  - sina:   新浪实时行情代码（仅服务端模式使用）
 *  - em:     东方财富 secid（119 = 外汇市场，133 = 离岸市场）
 *  - from/to: Frankfurter（ECB 日线）的基准/报价货币
 *  - pip:    1 个 pip 的数值（点差、滑点计价）
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
  { symbol: 'USDHKD', zh: '美元/港元', sina: 'fx_susdhkd', em: '119.USDHKD', from: 'USD', to: 'HKD', pip: 0.0001, digits: 5 },
  { symbol: 'USDSGD', zh: '美元/新加坡元', sina: 'fx_susdsgd', em: '119.USDSGD', from: 'USD', to: 'SGD', pip: 0.0001, digits: 5 },
  { symbol: 'USDMXN', zh: '美元/墨西哥比索', sina: 'fx_susdmxn', em: '119.USDMXN', from: 'USD', to: 'MXN', pip: 0.0001, digits: 4 },
];

export const pairMap = new Map(PAIRS.map((p) => [p.symbol, p]));

/** 数据源说明（服务端与浏览器共用同一份文案） */
export const SOURCES = [
  {
    id: 'ecb',
    name: 'ECB 日线（Frankfurter）',
    hasOhlc: false,
    annualBars: 252,
    tf: '1d',
    note: '欧央行每日参考汇率，工作日 16:00 CET 左右更新；只有收盘价，无开高低。数据可回溯到 1999 年。',
    credit: 'api.frankfurter.app',
  },
  {
    id: 'em',
    name: '东方财富分钟线（当日）',
    hasOhlc: true,
    annualBars: 252 * 1440,
    tf: '1m',
    note: '当天 06:00（北京时间）起的逐分钟 OHLC。只有「今天」，历史分钟线要靠自己采集积累。',
    credit: 'push2.eastmoney.com',
  },
  {
    id: 'sim',
    name: '模拟器（GBM 随机游走）',
    hasOhlc: true,
    annualBars: 252,
    tf: '1d',
    note: '几何布朗运动生成，参数可复现。真实参数已知——用来检验「策略到底抓到了信号，还是在拟合噪声」。',
    credit: 'fxlab 内置',
  },
];

export const sourceMap = new Map(SOURCES.map((s) => [s.id, s]));
export const sourceInfo = (id) => sourceMap.get(id) ?? SOURCES[0];

export const TIMEFRAMES = { '5s': 5000, '15s': 15000, '1m': 60000, '5m': 300000 };

/**
 * 抓取 ECB 日线并写入 web/data/ecb/{SYMBOL}.json —— 作为静态站点的「数据快照」。
 *
 * 为什么要做快照：
 *   浏览器直连 api.frankfurter.app 需要经过 Cloudflare，国内网络经常被拦或重置，
 *   控制台表现为 net::ERR_FAILED + CORS 报错。把数据在构建阶段取好、随站点一起发布，
 *   就完全不依赖用户访问国外接口。
 *
 * 只在构建时跑（GitHub Actions），产物不入库。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAIRS } from '../server/core/pairs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web', 'data', 'ecb');
const START = process.env.ECB_START || '1999-01-04';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPair(p) {
  const url = `https://api.frankfurter.app/${START}..?from=${p.from}&to=${p.to}`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const bars = Object.entries(j.rates || {})
        .map(([date, v]) => [date, Number(v[p.to])])
        .filter(([, c]) => Number.isFinite(c) && c > 0);
      if (bars.length < 100) throw new Error(`数据太少（${bars.length} 行）`);
      return bars;
    } catch (e) {
      lastErr = e;
      await sleep(1200 * (attempt + 1));
    }
  }
  throw lastErr;
}

await fs.mkdir(OUT, { recursive: true });

let ok = 0;
const failed = [];
for (const p of PAIRS) {
  try {
    const bars = await fetchPair(p);
    const payload = {
      symbol: p.symbol,
      from: p.from,
      to: p.to,
      updatedAt: new Date().toISOString(),
      lastDate: bars[bars.length - 1][0],
      bars,
    };
    await fs.writeFile(path.join(OUT, `${p.symbol}.json`), JSON.stringify(payload), 'utf8');
    const kb = (JSON.stringify(payload).length / 1024).toFixed(0);
    console.log(`  ✔ ${p.symbol.padEnd(7)} ${String(bars.length).padStart(5)} 行 → ${kb} KB`);
    ok += 1;
  } catch (e) {
    console.log(`  ✖ ${p.symbol.padEnd(7)} ${e.message}`);
    failed.push(p.symbol);
  }
}

// 索引文件：让前端知道快照的截止日期
await fs.writeFile(
  path.join(OUT, 'index.json'),
  JSON.stringify({ updatedAt: new Date().toISOString(), pairs: PAIRS.filter((p) => !failed.includes(p.symbol)).map((p) => p.symbol) }),
  'utf8',
);

console.log(`\n完成：${ok}/${PAIRS.length} 个货币对${failed.length ? '，失败：' + failed.join(',') : ''}`);
process.exit(failed.length > PAIRS.length / 2 ? 1 : 0);

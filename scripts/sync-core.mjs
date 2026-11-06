/**
 * 把服务端的「浏览器安全」核心模块复制到 web/js/core/。
 *
 * 为什么要复制而不是直接 import 服务端目录？
 *  静态托管（GitHub Pages）只能访问仓库里 web/ 这一棵子树，
 *  浏览器无法引用 ../server/**，所以必须在构建时把文件搬进来。
 *
 * 约束（脚本会自检）：被复制的模块不允许出现 node: 前缀的导入、
 * 也不允许引用 config.mjs（那里有 path / process）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'server', 'core');
const DST = path.join(ROOT, 'web', 'js', 'core');

const FILES = ['pairs.mjs', 'mathx.mjs', 'indicators.mjs', 'strategies.mjs', 'backtest.mjs', 'stats.mjs', 'simulator.mjs'];

const FORBIDDEN = [/from\s+['"]node:/, /from\s+['"][^'"]*config\.mjs['"]/, /\bprocess\.env\b/];

let copied = 0;
const problems = [];

for (const name of FILES) {
  const src = path.join(SRC, name);
  const text = await fs.readFile(src, 'utf8');
  for (const re of FORBIDDEN) {
    if (re.test(text)) problems.push(`${name} 含有不可用于浏览器的写法：${re}`);
  }
  await fs.mkdir(DST, { recursive: true });
  await fs.writeFile(path.join(DST, name), text, 'utf8');
  copied += 1;
}

if (problems.length) {
  console.error('\n✖ 同步失败，以下模块不能在浏览器里运行：');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log(`✔ 已同步 ${copied} 个核心模块 → web/js/core/`);

/**
 * 一键跑全部测试：node tests/run-all.mjs
 *
 * 为什么不用 `node --test`？
 * 它在 Windows 沙箱里会 fork 子进程并走管道，被策略拒绝（EPERM）。
 * 这里改用 stdio: 'inherit' 顺序执行，最后统一汇总。
 *
 * 会自动拉起一个独立端口(8799)的服务实例，跑完关掉。
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.FXLAB_TEST_PORT || '8799';
const BASE = `http://127.0.0.1:${PORT}`;
const node = process.execPath;

const suites = [
  { name: '量化内核', file: 'tests/quant.test.mjs' },
  { name: '图表几何', file: 'tests/chart.test.mjs' },
  { name: 'API 接口', file: 'tests/api-smoke.mjs' },
  { name: '前端渲染', file: 'tests/dom-smoke.mjs' },
];

console.log(`\n启动测试服务 @ ${BASE} …`);
const server = spawn(node, ['server/index.mjs'], {
  cwd: ROOT,
  env: { ...process.env, FXLAB_PORT: PORT },
  stdio: 'inherit',
});

const waitHealth = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const ok = await waitHealth();
if (!ok) {
  console.error('测试服务启动失败');
  server.kill();
  process.exit(1);
}

const results = [];
for (const s of suites) {
  console.log(`\n──────── ${s.name} ────────`);
  const r = spawnSync(node, [s.file], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, FXLAB_BASE: BASE },
  });
  results.push({ ...s, code: r.status ?? 1 });
}

server.kill();

const failed = results.filter((r) => r.code !== 0);
console.log('\n════════ 汇总 ════════');
for (const r of results) console.log(`  ${r.code === 0 ? '✔' : '✖'} ${r.name}`);
console.log(`\n${results.length - failed.length}/${results.length} 组通过\n`);
process.exit(failed.length ? 1 : 0);

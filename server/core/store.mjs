/**
 * 极简持久化：JSON 文件缓存 + JSONL 追加日志。
 * 不用数据库：教学项目要能让读者用记事本打开、肉眼核对。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../config.mjs';

const DIRS = {
  cache: path.join(DATA_DIR, 'cache'),
  ticks: path.join(DATA_DIR, 'ticks'),
  bars: path.join(DATA_DIR, 'bars'),
  experiments: path.join(DATA_DIR, 'experiments'),
};

export async function ensureDirs() {
  for (const d of Object.values(DIRS)) await fs.mkdir(d, { recursive: true });
}

export function dataPath(kind, name) {
  const d = DIRS[kind];
  if (!d) throw new Error(`未知数据目录 ${kind}`);
  return path.join(d, name);
}

export async function readJSON(name, kind = 'cache') {
  try {
    return JSON.parse(await fs.readFile(dataPath(kind, name), 'utf8'));
  } catch {
    return null;
  }
}

export async function writeJSON(name, obj, kind = 'cache') {
  const file = dataPath(kind, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj), 'utf8');
  return obj;
}

/** 追加一行 JSON；自动按天/按名分文件由调用方决定 */
export async function appendJSONL(name, obj, kind = 'bars') {
  const file = dataPath(kind, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(obj) + '\n', 'utf8');
}

export async function readJSONL(name, { kind = 'bars', limit = 0 } = {}) {
  let text;
  try {
    text = await fs.readFile(dataPath(kind, name), 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n').filter(Boolean);
  const picked = limit > 0 ? lines.slice(-limit) : lines;
  const out = [];
  for (const line of picked) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 采集过程中进程被杀会留下半行，跳过即可 */
    }
  }
  return out;
}

export async function listFiles(kind) {
  try {
    return (await fs.readdir(DIRS[kind])).sort();
  } catch {
    return [];
  }
}

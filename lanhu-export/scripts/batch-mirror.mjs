#!/usr/bin/env node
/**
 * batch-mirror — 批量镜像多个蓝湖版本，每个版本一个独立文件夹。
 * 读取 versions.tsv（name\tURL），逐版本运行 mirror-axure.mjs。
 * 支持断点续跑：某版本目录已含完整 index.html 则跳过。
 *
 * 用法：node batch-mirror.mjs [版本清单.tsv] [输出目录] [起始序号]
 *   例：node batch-mirror.mjs "./versions.tsv" "./蓝湖版本导出" 1
 */
import { execFile } from 'node:child_process';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));

// 通用参数：node batch-mirror.mjs [版本清单.tsv] [输出目录] [起始序号]
//   版本清单.tsv：每行 "版本名<TAB>URL"，默认读取当前目录 ./versions.tsv
//   输出目录：默认 ./蓝湖导出（相对于运行目录）
const VERSIONS_FILE = resolve(process.argv[2] && process.argv[2].endsWith('.tsv') ? process.argv[2] : join(process.cwd(), 'versions.tsv'));
const BASE = resolve(process.argv[3] && !/^\d+$/.test(process.argv[3]) ? process.argv[3] : '蓝湖导出');
const START = parseInt(process.argv[3] && /^\d+$/.test(process.argv[3]) ? process.argv[3] : (process.argv[4] || '1'), 10);
mkdirSync(BASE, { recursive: true });

const tsv = readFileSync(VERSIONS_FILE, 'utf-8');
const versions = tsv.split('\n').filter(Boolean).map(line => {
  const i = line.indexOf('\t');
  return { name: line.slice(0, i), url: line.slice(i + 1) };
});
console.log(`版本清单：${VERSIONS_FILE}`);
console.log(`共 ${versions.length} 个版本，从第 ${START} 个开始。输出到 ${BASE}\n`);

function sanitize(n) { return n.replace(/[\\/:*?"<>|()]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'version'; }

function runMirror(url, outDir) {
  return new Promise(resolve => {
    const child = execFile('node', [join(__dirname, 'mirror-axure.mjs'), url, '--out', outDir],
      { timeout: 1800000, maxBuffer: 64 * 1024 * 1024 }, // 30 分钟超时，兼容 195 页的大版本
      (err, stdout, stderr) => {
        resolve({ err, out: (stdout || '') + (stderr || '') });
      });
  });
}

async function main() {
  const results = [];
  for (let i = 0; i < versions.length; i++) {
    const idx = i + 1;
    if (idx < START) continue;
    const v = versions[i];
    const folder = sanitize(v.name);
    const outDir = join(BASE, folder);
    const doneMarker = join(outDir, 'index.html');

    if (existsSync(doneMarker) && statSync(doneMarker).size > 500 && existsSync(join(outDir, 'manifest.json'))) {
      console.log(`[${String(idx).padStart(2, '0')}/${versions.length}] ⏭ 已完成，跳过：${v.name}`);
      results.push({ idx, name: v.name, status: 'skipped' });
      continue;
    }

    console.log(`\n[${String(idx).padStart(2, '0')}/${versions.length}] ▶ 开始：${v.name}`);
    console.log(`    输出：${outDir}`);
    const t0 = Date.now();
    const { err, out } = await runMirror(v.url, outDir);
    const secs = Math.round((Date.now() - t0) / 1000);
    const ok = !err && existsSync(doneMarker);
    const pageCount = ok && existsSync(join(outDir, 'manifest.json'))
      ? JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf-8')).length : 0;
    // 记录关键行
    const keyLines = (out || '').split('\n').filter(l => /镜像完成|补漏抓取|页面|运行出错|Error/i.test(l)).slice(-4);
    console.log(`    ${ok ? '✔ 完成' : '✘ 失败'}（${secs}s，页面 ${pageCount} 页）`);
    keyLines.forEach(l => console.log('    ·', l.trim().slice(0, 120)));
    if (!ok) console.log('    · 错误详情（尾部）：', (out || '').split('\n').slice(-6).join(' | ').slice(0, 300));
    results.push({ idx, name: v.name, status: ok ? 'ok' : 'fail', secs, pageCount });

    // 每完成一个写进度
    mkdirSync(BASE, { recursive: true });
    const progress = results.map(r => `[${String(r.idx).padStart(2, '0')}] ${r.name} → ${r.status}`).join('\n');
    writeFileSync(join(BASE, '进度.log'), progress + '\n', 'utf-8');
  }

  const okCount = results.filter(r => r.status === 'ok').length;
  const failCount = results.filter(r => r.status === 'fail').length;
  console.log(`\n===== 全部结束：成功 ${okCount}，失败 ${failCount}，跳过 ${results.filter(r=>r.status==='skipped').length} =====`);
  results.filter(r => r.status === 'fail').forEach(r => console.log(`  ✘ ${r.name}`));
  console.log(`进度文件：${join(BASE, '进度.log')}`);
}

main().catch(e => { console.error('批量运行出错：', e); process.exit(1); });

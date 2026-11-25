#!/usr/bin/env node
/**
 * export-prototype — 导出蓝湖 Axure 原型为设计文档
 * ==================================================
 * 用户看到什么就导出什么：遍历原型页面树（所有层级、所有页面），
 * 逐页渲染并截图，最终生成一份 HTML 设计文档（含目录层级 + 每页截图）。
 *
 * 用法：
 *   node export-prototype.mjs <原型URL> [--out <目录>] [--headful]
 *
 * 输出：
 *   <out>/
 *     images/01_xxx.png           每页截图
 *     manifest.json               页面清单（含层级路径）
 *     设计文档.html               设计文档（侧边目录 + 页面截图）
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const args = { url: null, out: 'prototype-export', headful: false, profile: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') args.out = argv[++i];
  else if (a === '--headful') args.headful = true;
  else if (a === '--profile') args.profile = argv[++i];
  else if (!a.startsWith('--')) args.url = a;
}
if (!args.url) { console.error('用法：node export-prototype.mjs <原型URL> [--out <目录>]'); process.exit(1); }

const PROFILE = args.profile || join(homedir(), '.lanhu-skill', 'chrome-profile');
const OUT = resolve(args.out);
const IMG = join(OUT, 'images');
mkdirSync(IMG, { recursive: true });

// ---------- 树结构收集 ----------
// 从侧边栏读取原型页面树。返回 [{ name, depth, isFolder }]，depth 由 deepD-N 类得出。
async function collectTree(page) {
  return await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.lan-tree-list-item.directory-list-item'));
    const result = [];
    for (const it of items) {
      const cls = it.className || '';
      const m = cls.match(/deepD-(\d+)/);
      const depth = m ? parseInt(m[1], 10) : 0;
      const box = it.querySelector('.item-box');
      const name = (box?.innerText || it.innerText || '').trim().replace(/\s+/g, ' ');
      const isFolder = !!(box && box.className.includes('has-children'));
      result.push({ name, depth, isFolder });
    }
    return result;
  });
}

// 展开所有折叠的文件夹（点击展开箭头），直到不再变化。
async function expandAll(page) {
  for (let round = 0; round < 10; round++) {
    const changed = await page.evaluate(() => {
      // 找到尚未展开、含 has-children 的 item-box 前的展开箭头
      const items = Array.from(document.querySelectorAll('.lan-tree-list-item.directory-list-item'));
      let clicked = false;
      for (const it of items) {
        const box = it.querySelector('.item-box.has-children');
        if (!box) continue;
        // 若父容器没有 expanded 类，尝试点击展开图标
        const wrap = it.querySelector('.item-box') || box;
        const arrow = wrap.querySelector('.icon, [class*="arrow"], [class*="expand"], [class*="iconfont"], [class*="arrow-icon"]');
        if (arrow) { arrow.click(); clicked = true; }
        else if (!it.className.includes('expanded')) { /* 点击 item 尝试展开 */ }
      }
      return clicked;
    });
    await sleep(800);
    if (!changed) break;
  }
}

// 展开所有文件夹（逐个点击，处理懒加载）
async function expandAllFolders(page) {
  // 反复读取树并点击所有含 has-children 的条目，直到树不再增长
  let prevCount = -1;
  for (let i = 0; i < 15; i++) {
    const tree = await collectTree(page);
    if (tree.length === prevCount) break;
    prevCount = tree.length;
    // 点击每个文件夹条目（用其文本定位）
    const names = tree.filter(t => t.isFolder).map(t => t.name);
    for (const n of names) {
      try {
        const loc = page.locator('.lan-tree-list-item.directory-list-item', { hasText: n }).first();
        await loc.click({ timeout: 2000 });
        await sleep(300);
      } catch { /* 忽略 */ }
    }
    await sleep(800);
  }
}

// 计算每个条目的层级路径（依据深度 + 是否文件夹）
function buildPaths(tree) {
  const stack = []; // 每层当前文件夹名
  const rows = [];
  tree.forEach((t, index) => {
    while (stack.length > t.depth) stack.pop();
    stack[t.depth] = t.name;
    const path = stack.slice(0, t.depth + 1).join(' / ');
    rows.push({ ...t, index, path, ancestors: stack.slice(0, t.depth).join(' / ') });
  });
  return rows;
}

// 找到 axure iframe（可能重新加载，需反复查找）
function getAxureFrame(page) {
  return page.frames().find(f => (f.url() || '').includes('axure-file')) || null;
}

// 等待 iframe 加载并渲染某页面：轮询 iframe 标题包含页面名
async function waitForPageRender(page, pageName, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const frame = getAxureFrame(page);
    if (frame) {
      try {
        const title = await frame.evaluate(() => document.title).catch(() => '');
        if (title && title.replace(/\s+/g, ' ').includes(pageName.replace(/\s+/g, ' '))) {
          // 再等渲染稳定
          await sleep(1500);
          return frame;
        }
      } catch { /* 继续 */ }
    }
    await sleep(500);
  }
  return getAxureFrame(page);
}

// 找到设计内容元素（最大的 ax_default 元素，排除整页背景），返回其 Playwright locator。
async function getDesignLocator(frame) {
  // 找出最大 ax_default 元素的下标
  const idx = await frame.evaluate(() => {
    const els = Array.from(document.querySelectorAll('[class*="ax_default"]'));
    let best = -1, bestArea = 0;
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      // 设计稿一般为 200~2200 宽、100+ 高
      if (r.width > 200 && r.width < 2200 && r.height > 100) {
        const a = r.width * r.height;
        if (a > bestArea) { bestArea = a; best = i; }
      }
    }
    return best;
  }).catch(() => -1);
  if (idx < 0) return null;
  return frame.locator('[class*="ax_default"]').nth(idx);
}

// 从 iframe 提取页面文本（备用信息，写入文档）
async function extractPageText(frame) {
  return await frame.evaluate(() => {
    const el = document.querySelector('[class*="ax_default"]');
    return (el ? el.innerText : document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 800);
  }).catch(() => '');
}

function sanitize(n) { return n.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'untitled'; }

// ---------- 主流程 ----------
async function main() {
  console.log('蓝湖原型 → 设计文档 导出');
  console.log('  目标 :', args.url);
  console.log('  输出 :', OUT);

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome', headless: !args.headful, viewport: { width: 1440, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.setDefaultTimeout(15000);

  try {
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(4000);

    // 展开所有文件夹，收集完整页面树
    console.log('展开原型页面树…');
    await expandAllFolders(page);
    await sleep(1000);

    const tree = await collectTree(page);
    if (!tree.length) { console.error('未读取到页面树。'); await ctx.close(); process.exit(1); }
    const rows = buildPaths(tree);
    const pages = rows.filter(r => !r.isFolder); // 叶子 = 页面
    console.log(`页面树条目 ${tree.length} 个，其中页面（叶子）${pages.length} 个，文件夹 ${rows.filter(r=>r.isFolder).length} 个。`);
    console.log('页面清单：');
    pages.forEach((p, i) => console.log(`  ${i + 1}. [${p.path}]`));

    const manifest = [];
    const docTexts = {};
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      const display = `${p.path}`;
      console.log(`\n[${i + 1}/${pages.length}] 导出：${display}`);
      // 点击页面条目（按树中的下标定位，避免同名页面混淆）
      try {
        await page.locator('.lan-tree-list-item.directory-list-item').nth(p.index).click({ timeout: 5000 });
      } catch (e) {
        console.warn(`  点击失败：${e.message}`);
        manifest.push({ title: p.name, path: p.path, file: null, error: e.message });
        continue;
      }
      // 等待渲染
      const frame = await waitForPageRender(page, p.name);
      await sleep(1000);
      // 截图
      const loc = await getDesignLocator(frame);
      let file = null, error = null;
      if (loc) {
        try {
          const fname = `${String(i + 1).padStart(2, '0')}_${sanitize(p.name)}.png`;
          await loc.screenshot({ path: join(IMG, fname), animations: 'disabled', timeout: 30000 });
          file = `images/${fname}`;
          console.log(`  ✔ 截图 → ${file}`);
        } catch (e) { error = e.message; console.warn(`  截图失败：${e.message}`); }
      } else {
        error = '未找到设计元素';
        console.warn(`  ${error}`);
      }
      const text = await extractPageText(frame).catch(() => '');
      docTexts[p.path] = text;
      manifest.push({ title: p.name, path: p.path, ancestors: p.ancestors, depth: p.depth, file, text, error });
    }

    // 生成设计文档 HTML
    writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    const html = buildHtml(manifest, basename(OUT));
    writeFileSync(join(OUT, '设计文档.html'), html, 'utf-8');
    console.log(`\n完成：${manifest.length} 页，成功 ${manifest.filter(m => m.file).length} 页。`);
    console.log(`设计文档：${join(OUT, '设计文档.html')}`);
  } finally {
    await ctx.close();
  }
}

// ---------- HTML 设计文档 ----------
function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function buildHtml(manifest, title) {
  const items = manifest.map((m, i) => `
    <section class="page" id="page-${i}">
      <div class="page-head">
        <div class="crumbs">${m.path.split(' / ').map(esc).map((c, j) => `<span class="crumb">${c}</span>`).join('<span class="sep">›</span>')}</div>
      </div>
      ${m.file
        ? `<div class="shot"><img src="${esc(m.file)}" alt="${esc(m.title)}" loading="lazy"></div>`
        : `<div class="shot missing">（${esc(m.error || '未导出')}）</div>`}
      ${m.text ? `<details class="note"><summary>页面文本</summary><pre>${esc(m.text)}</pre></details>` : ''}
    </section>`).join('');

  const toc = manifest.map((m, i) => {
    const ind = m.depth * 16;
    return `<li style="padding-left:${ind}px"><a href="#page-${i}">${esc(m.title)}</a></li>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · 设计文档</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f0f2f5; color: #222; }
  header { position: sticky; top: 0; z-index: 10; background: #1f2a44; color: #fff; padding: 14px 24px; font-size: 18px; font-weight: 600; }
  header small { font-weight: 400; opacity: .7; margin-left: 10px; font-size: 12px; }
  .layout { display: flex; }
  nav { width: 280px; min-width: 280px; background: #fff; border-right: 1px solid #e5e7eb; height: calc(100vh - 52px); position: sticky; top: 52px; overflow: auto; padding: 12px 0; }
  nav ul { list-style: none; margin: 0; padding: 0; }
  nav li a { display: block; padding: 6px 14px; color: #333; text-decoration: none; font-size: 13px; border-left: 3px solid transparent; }
  nav li a:hover { background: #f5f7fa; border-left-color: #4c7cf0; }
  main { flex: 1; padding: 24px; }
  .page { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 28px; overflow: hidden; }
  .page-head { padding: 12px 18px; border-bottom: 1px solid #eef0f3; background: #fafbfc; }
  .crumbs { font-size: 14px; }
  .crumb { color: #4c7cf0; }
  .crumb:last-child { color: #111; font-weight: 600; }
  .sep { margin: 0 6px; color: #aaa; }
  .shot { padding: 16px; display: flex; justify-content: center; background: #f7f8fa; }
  .shot img { max-width: 100%; height: auto; border: 1px solid #e5e7eb; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
  .shot.missing { color: #999; padding: 40px; font-size: 14px; }
  .note { border-top: 1px solid #eef0f3; padding: 10px 18px; font-size: 13px; }
  .note summary { cursor: pointer; color: #666; }
  .note pre { white-space: pre-wrap; word-break: break-all; font-size: 12px; color: #555; background: #fafbfc; padding: 10px; border-radius: 4px; }
</style></head>
<body>
<header>${esc(title)} <small>设计文档 · ${manifest.length} 页</small></header>
<div class="layout">
  <nav><ul>${toc}</ul></nav>
  <main>${items}</main>
</div>
</body></html>`;
}

main().catch(e => { console.error('运行出错：', e); process.exit(1); });

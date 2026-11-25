#!/usr/bin/env node
/**
 * mirror-axure — 镜像蓝湖 Axure 原型为本地可交互原型
 * =====================================================
 * 蓝湖每个页面是独立的编译后 HTML（axure-file.lanhuapp.com/md5__*.html），
 * 通过镜像全部页面 HTML + 所有 CSS/JS/图片资源 + 重写跨域引用，
 * 可在本地 100% 还原原型的交互与内容（与蓝湖显示完全一致）。
 *
 * 用法：
 *   node mirror-axure.mjs <原型URL> [--out <目录>] [--headful]
 *
 * 输出：
 *   <out>/mirror/            镜像的 Axure 工程（axure-file/ alistatic/ axure-file-readonly/）
 *   <out>/index.html         原型入口（左侧页面树 + iframe 切换，同蓝湖）
 *   <out>/manifest.json      页面清单
 *   <out>/serve.mjs          本地静态服务器（双击打开或 node serve.mjs）
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const args = { url: null, out: 'axure-prototype', headful: false, profile: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') args.out = argv[++i];
  else if (a === '--headful') args.headful = true;
  else if (a === '--profile') args.profile = argv[++i];
  else if (!a.startsWith('--')) args.url = a;
}
if (!args.url) { console.error('用法：node mirror-axure.mjs <原型URL> [--out <目录>]'); process.exit(1); }

const PROFILE = args.profile || join(homedir(), '.lanhu-skill', 'chrome-profile');
const OUT = resolve(args.out);
const MIRROR = join(OUT, 'mirror');
rmSync(MIRROR, { recursive: true, force: true }); // 仅清空本次生成的镜像子目录
mkdirSync(MIRROR, { recursive: true });

// 需要镜像的域名
const HOSTS = ['axure-file.lanhuapp.com', 'alistatic.lanhuapp.com', 'axure-file-readonly.lanhuapp.com'];

function isMirrorable(url) {
  try { const u = new URL(url); return HOSTS.includes(u.hostname) && u.protocol.startsWith('http'); }
  catch { return false; }
}
// 把 URL 转成本地镜像路径（保留 host/子目录结构，去掉 query）
function urlToLocalPath(url) {
  const u = new URL(url);
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith('/')) p += 'index.html';
  return join(u.hostname, p);
}

// ---------- 树收集（同 export-prototype） ----------
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
async function expandAllFolders(page) {
  let prevCount = -1;
  for (let i = 0; i < 15; i++) {
    const tree = await collectTree(page);
    if (tree.length === prevCount) break;
    prevCount = tree.length;
    const names = tree.filter(t => t.isFolder).map(t => t.name);
    for (const n of names) {
      try { await page.locator('.lan-tree-list-item.directory-list-item', { hasText: n }).first().click({ timeout: 2000 }); await sleep(300); }
      catch { /* 忽略 */ }
    }
    await sleep(800);
  }
}
function buildPaths(tree) {
  const stack = [];
  return tree.map((t, index) => {
    while (stack.length > t.depth) stack.pop();
    stack[t.depth] = t.name;
    return { ...t, index, path: stack.slice(0, t.depth + 1).join(' / '), ancestors: stack.slice(0, t.depth).join(' / ') };
  });
}
function getAxureFrame(page) {
  return page.frames().find(f => (f.url() || '').includes('axure-file.lanhuapp.com')) || null;
}
async function waitForFrameChange(page, prevUrl, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const f = getAxureFrame(page);
    if (f && f.url() !== prevUrl && f.url().includes('.html')) return f;
    await sleep(400);
  }
  return getAxureFrame(page);
}

// ---------- 主流程 ----------
async function main() {
  console.log('镜像蓝湖 Axure 原型 → 本地可交互原型');
  console.log('  目标 :', args.url);
  console.log('  输出 :', OUT);

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome', headless: !args.headful, viewport: { width: 1440, height: 900 },
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.setDefaultTimeout(15000);

  const savedFiles = new Set();   // 已保存的本地路径
  let savedCount = 0;

  // 捕获浏览器实际加载的每个资源（HTML/JS/CSS/JSON/图片等）
  page.on('response', async (resp) => {
    const url = resp.url();
    if (!isMirrorable(url)) return;
    try {
      const body = await resp.body();
      if (!body || !body.length) return;
      const local = urlToLocalPath(url.split('?')[0]);
      const abs = join(MIRROR, local);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
      savedFiles.add(local);
      savedCount++;
    } catch (e) { /* 某些响应无法读 body，忽略 */ }
  });

  try {
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(4000);
    // 注销 Service Worker 并清空缓存，确保后续逐页加载都走网络、能被捕获
    await page.evaluate(async () => {
      try {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        }
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
      } catch (e) { /* 忽略 */ }
    }).catch(() => {});
    console.log('已注销 Service Worker 并清空缓存。');
    // 重新加载，确保首屏资源也走网络被捕获
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3000);

    // 检测安全横幅（打开过"分享"页后蓝湖提示"请重新登录"）。横幅不阻塞内容访问——
    // 页面树与原型仍可正常加载，点掉横幅后继续即可，无需退出。
    const pageText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    if (/请重新登录|用户状态发生变化/.test(pageText)) {
      console.log('检测到"请重新登录"安全横幅（打开过分享页所致）。点掉横幅后继续，内容仍可访问…');
      try {
        const ok = page.locator('text=知道了').first();
        if (await ok.count()) { await ok.click({ timeout: 4000 }); await sleep(1500); }
        await page.evaluate(() => document.querySelector('.anonymous_tip')?.remove()).catch(() => {});
      } catch (e) { console.warn(`  关闭横幅（忽略）：${e.message}`); }
    }

    // 若页面树为空，尝试点击产品文档（.rp）打开原型——某些版本需先进入文档
    let probe = await collectTree(page);
    if (!probe.length) {
      console.log('页面树为空，尝试点击产品文档打开原型…');
      try {
        const doc = page.locator('.popover-prototype-list-item, [class*="prototype-list-item"], .lan-dnd-item').first();
        if (await doc.count()) {
          await doc.click({ timeout: 5000 });
          await sleep(5000);
          probe = await collectTree(page);
          console.log(`  点击文档后树条目：${probe.length}`);
        }
      } catch (e) { console.warn(`  打开文档失败：${e.message}`); }
    }

    console.log('展开页面树…');
    await expandAllFolders(page);
    await sleep(1000);

    const tree = await collectTree(page);
    const rows = buildPaths(tree);
    const pages = rows.filter(r => !r.isFolder);
    console.log(`页面树 ${tree.length} 条目，页面 ${pages.length} 个。开始逐页加载并记录每页 HTML…`);

    const pageFiles = [];
    let lastFrameUrl = getAxureFrame(page)?.url() || '';
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      try {
        await page.locator('.lan-tree-list-item.directory-list-item').nth(p.index).click({ timeout: 5000 });
      } catch (e) { console.warn(`  [${i + 1}] 点击失败 ${p.name}: ${e.message}`); continue; }
      // 等待 iframe 换成新页面 HTML
      const frame = await waitForFrameChange(page, lastFrameUrl);
      const fUrl = frame ? frame.url() : lastFrameUrl;
      if (fUrl !== lastFrameUrl) {
        lastFrameUrl = fUrl;
        // 等页面资源加载
        await sleep(2500);
        const fname = urlToLocalPath(fUrl.split('?')[0]);
        pageFiles.push({ ...p, url: fUrl.split('?')[0], localFile: fname });
        // 捕获渲染后的 DOM：此时资源引用已被 Lanhu 解析为哈希 URL（md5__*.js 等），
        // 用它替换原始 HTML，配合本地哈希资源即可离线重渲染。
        try {
          const rendered = await frame.evaluate(() => document.documentElement.outerHTML);
          if (rendered && rendered.length > 1000) {
            const abs = join(MIRROR, fname);
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, rendered, 'utf-8');
          }
        } catch (e) { console.warn(`  [渲染 DOM 捕获失败] ${p.name}: ${e.message}`); }
        console.log(`  [${i + 1}/${pages.length}] ${p.path}  →  ${fname}`);
      } else {
        console.log(`  [${i + 1}/${pages.length}] ${p.path}  （iframe 未变化，沿用 ${fname || ''}）`);
      }
    }
    await sleep(1500);

    console.log(`\n镜像完成：保存 ${savedCount} 个资源文件。`);

    // 补漏：用认证请求直接抓取所有 HTML/JS/CSS 引用的资源（绕过浏览器缓存）
    console.log('补漏：直接抓取 HTML 引用的资源…');
    const fetched = await fillMissing(ctx);
    console.log(`  补漏抓取 ${fetched} 个资源。`);
    console.log('重写跨域引用 → 本地相对路径…');
    rewriteCrossHostRefs(MIRROR);

    // ---------- 生成入口 index.html ----------
    const toc = pages.map((p, i) => {
      const pf = pageFiles.find(x => x.index === p.index);
      const ind = p.depth * 16;
      const href = pf ? pf.localFile : '';
      return `<li style="padding-left:${ind}px" data-idx="${i}"><a data-href="${escAttr(href)}" href="javascript:void(0)">${esc(p.name)}</a></li>`;
    }).join('');

    const indexHtml = buildIndexHtml(OUT, toc, pageFiles, pages);
    writeFileSync(join(OUT, 'index.html'), indexHtml, 'utf-8');
    writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(pageFiles.map(f => ({ title: f.name, path: f.path, depth: f.depth, file: f.localFile })), null, 2), 'utf-8');
    writeFileSync(join(OUT, 'serve.mjs'), SERVER_JS, 'utf-8');
    console.log(`入口：${join(OUT, 'index.html')}`);
    console.log(`服务器：${join(OUT, 'serve.mjs')}`);
    console.log('\n运行：node serve.mjs 然后浏览器打开 http://localhost:8765');
  } finally {
    await ctx.close();
  }
}

function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

// 遍历目录，对每个文件调用回调（传绝对路径）
function walk(dir, cb) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) walk(p, cb);
    else cb(p);
  }
}

// 补漏：用认证的 APIRequestContext 直接抓取所有 HTML/JS/CSS 引用的、尚未保存的资源。
async function fillMissing(ctx) {
  const BASE = 'https://axure-file.lanhuapp.com/';
  let fetched = 0;
  const seen = new Set();
  for (let pass = 0; pass < 4; pass++) {
    const refs = new Set();
    walk(MIRROR, (file) => {
      if (!/\.(html|js|css)$/.test(file)) return;
      let txt;
      try { txt = readFileSync(file, 'utf-8'); } catch { return; }
      const re = /(?:src|href)\s*=\s*["']([^"']+\.(?:js|css|json|png|gif|svg|woff2?|html))["']/g;
      let m;
      while ((m = re.exec(txt))) {
        let u = m[1];
        if (u.startsWith('//')) u = 'https:' + u;
        else if (u.startsWith('http')) { /* 绝对 */ }
        else if (u.startsWith('./')) u = BASE + u.slice(2);
        else if (u.startsWith('/')) u = 'https:' + u;
        else u = BASE + u;
        refs.add(u);
      }
    });
    let newFetched = 0;
    for (const url of refs) {
      const key = url.split('?')[0];
      if (seen.has(key)) continue;
      if (!isMirrorable(url)) continue;
      seen.add(key);
      const local = urlToLocalPath(key);
      const abs = join(MIRROR, local);
      if (existsSync(abs)) continue;
      try {
        const resp = await ctx.request.get(url, { timeout: 20000 });
        if (resp.ok()) {
          const body = await resp.body();
          if (body && body.length) {
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, body);
            newFetched++; fetched++;
          }
        }
      } catch { /* 忽略 */ }
    }
    if (newFetched === 0) break;
  }
  return fetched;
}

// 把跨域绝对 URL（alistatic / axure-file-readonly）重写为指向本地镜像的相对路径。
// 页面 HTML 位于 mirror/axure-file.lanhuapp.com/ 下，跨域资源位于 mirror/<host>/ 下，
// 因此用 ../<host>/... 可达。同时补建透明图与 Other.html 占位。
function rewriteCrossHostRefs(mirrorRoot) {
  const hosts = ['alistatic.lanhuapp.com', 'axure-file-readonly.lanhuapp.com'];
  function walk(dir) {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.name.endsWith('.html') || name.name.endsWith('.js') || name.name.endsWith('.css')) {
        try {
          let txt = readFileSync(p, 'utf-8');
          // 从该文件所在目录到 mirror 根的相对前缀（如 ../..）
          let d = dirname(p), n = 0;
          while (d !== mirrorRoot && d !== dirname(mirrorRoot) && d !== '/') { d = dirname(d); n++; }
          const relUp = n === 0 ? './' : '../'.repeat(n);
          for (const h of hosts) {
            const re = new RegExp('(?:https?:)?\\/\\/' + h.replace(/\./g, '\\.') + '\\/', 'g');
            txt = txt.replace(re, relUp + h + '/');
          }
          writeFileSync(p, txt, 'utf-8');
        } catch { /* 忽略二进制 */ }
      }
    }
  }
  walk(mirrorRoot);
  // 占位资源
  const axureDir = join(mirrorRoot, 'axure-file.lanhuapp.com');
  const resImg = join(axureDir, 'resources', 'images');
  mkdirSync(resImg, { recursive: true });
  const gif = join(resImg, 'transparent.gif');
  if (!existsSync(gif)) writeFileSync(gif, Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  const other = join(axureDir, 'resources', 'Other.html');
  if (!existsSync(other)) writeFileSync(other, '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>', 'utf-8');
}

function buildIndexHtml(outDir, toc, pageFiles, pages) {
  const firstPage = pageFiles[0] ? pageFiles[0].localFile : '';
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>蓝湖原型 · 离线版</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; display: flex; height: 100vh; background: #eef1f5; }
  #sidebar { width: 260px; min-width: 260px; background: #fff; border-right: 1px solid #e3e6eb; overflow: auto; padding: 10px 0; }
  #sidebar h3 { margin: 0; padding: 10px 14px; font-size: 13px; color: #666; font-weight: 600; }
  #sidebar ul { list-style: none; margin: 0; padding: 0; }
  #sidebar li a { display: block; padding: 6px 12px; color: #333; font-size: 13px; text-decoration: none; border-left: 3px solid transparent; cursor: pointer; }
  #sidebar li a:hover { background: #f3f6fb; }
  #sidebar li a.active { background: #eaf1ff; border-left-color: #4c7cf0; color: #1a56d6; }
  #content { flex: 1; position: relative; background: #f5f6f8; }
  #frame { width: 100%; height: 100%; border: 0; background: #fff; }
  #placeholder { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #999; }
</style></head>
<body>
<div id="sidebar">
  <h3>页面导航</h3>
  <ul>${toc}</ul>
</div>
<div id="content">
  <iframe id="frame" src="${firstPage ? 'mirror/' + escAttr(firstPage) : 'about:blank'}"></iframe>
</div>
<script>
  const links = Array.from(document.querySelectorAll('#sidebar li a'));
  const frame = document.getElementById('frame');
  links.forEach(a => {
    a.addEventListener('click', () => {
      const href = a.getAttribute('data-href');
      if (href) { frame.src = 'mirror/' + href; }
      links.forEach(x => x.classList.remove('active'));
      a.classList.add('active');
    });
  });
</script>
</body></html>`;
}

// 本地静态服务器
const SERVER_JS = `#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8765;
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.jpg':'image/jpeg', '.gif':'image/gif', '.json':'application/json', '.svg':'image/svg+xml', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf' };
createServer(async (req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = join(ROOT, p);
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
    res.end(data);
  } catch (e) { res.writeHead(404); res.end('404: ' + p); }
}).listen(PORT, () => console.log('原型服务器已启动: http://localhost:' + PORT));
`;

main().catch(e => { console.error('运行出错：', e); process.exit(1); });

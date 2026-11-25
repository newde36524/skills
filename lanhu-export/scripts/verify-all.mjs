#!/usr/bin/env node
// 全面验证离线原型：逐页点击，检查每页是否渲染出内容。
import { chromium } from 'playwright';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ctx = await chromium.launch({ channel: 'chrome', headless: true, viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const fails = new Set();
page.on('response', r => { if (r.status() >= 400) fails.add(r.status() + ' ' + r.url().replace('http://localhost:8765/', '')); });
await page.goto('http://localhost:8765/index.html', { waitUntil: 'networkidle', timeout: 30000 });
await sleep(2500);

const links = page.locator('#sidebar a');
const n = await links.count();
console.log('侧边页面数:', n);
let ok = 0, bad = 0;
for (let i = 0; i < n; i++) {
  const name = (await links.nth(i).innerText()).trim();
  await links.nth(i).click();
  await sleep(1800);
  const frame = page.frames().find(f => f !== page.mainFrame());
  let info = { title: '', imgs: 0, textLen: 0 };
  if (frame) {
    info = await frame.evaluate(() => ({
      title: document.title,
      imgs: document.querySelectorAll('img').length,
      textLen: (document.body.innerText || '').trim().length,
    })).catch(() => ({ title: '(读取失败)', imgs: 0, textLen: 0 }));
  }
  const rendered = info.imgs > 0 || info.textLen > 50;
  if (rendered) ok++; else bad++;
  console.log(`  [${String(i + 1).padStart(2, '0')}] ${name} → title="${info.title}" imgs=${info.imgs} 文本=${info.textLen} ${rendered ? '✔' : '✘'}`);
}
console.log(`\n渲染成功 ${ok}/${n}，失败 ${bad}。`);
console.log('=== 404/错误（全项目）===');
[...fails].slice(0, 15).forEach(f => console.log('  ', f));
if (!fails.size) console.log('  无');
await ctx.close();

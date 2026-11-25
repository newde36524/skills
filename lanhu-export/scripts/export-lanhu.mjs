#!/usr/bin/env node
/**
 * lanhu-export — 蓝湖需求文档导出引擎
 * ====================================
 * 当用户给出一个蓝湖（lanhuapp.com）地址时，导出该项目下所有的需求文档（需求文档 / 需求说明）。
 *
 * 工作方式：
 *   1. 使用系统 Chrome（持久化登录态）打开蓝湖地址
 *   2. 首次运行时若未登录，会弹出浏览器窗口，请手动登录
 *   3. 进入项目后，自动发现“需求文档”列表
 *   4. 逐篇打开每篇需求文档，提取标题与正文，保存为 Markdown
 *
 * 用法：
 *   node export-lanhu.mjs <蓝湖URL> [--out <输出目录>] [--discover] [--headful] [--doc-selector <CSS>]
 *
 * 参数：
 *   <蓝湖URL>          必填。项目页或需求文档页地址。
 *   --out <目录>       导出目录（默认 ./lanhu-export-output）
 *   --discover         只做“结构发现”：打开页面并打印可点击链接与文本，便于确定选择器，不导出。
 *   --headful          强制显示浏览器窗口（默认登录页会自动弹出窗口；已登录时默认无头）。
 *   --doc-selector <CSS>  手动指定需求文档条目的 CSS 选择器，覆盖配置文件。
 *   --profile <路径>   自定义 Chrome 持久化配置目录（默认 ~/.lanhu-skill/chrome-profile）。
 *
 * 配置文件：scripts/lanhu.config.json（可选）— 见文件内说明。命令行参数优先级更高。
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = resolve(fileURLToPath(new URL('.', import.meta.url)));

// ---------- 默认配置 ----------
// 这些选择器基于蓝湖 Web 端的常见结构，若与实际页面不符，请用 --discover 找到正确选择器后
// 填入 scripts/lanhu.config.json，或直接通过命令行 --doc-selector 覆盖。
const DEFAULT_CONFIG = {
  // 登录后跳转检测：判断是否仍停留在登录页。若命中则等待用户手动登录。
  loginIndicators: [
    'input[type="password"]',
    'text=登录',
    'button:has-text("登录")',
  ],
  // 需求文档列表页的“需求文档”标签/入口。可为空字符串表示由脚本启发式探测。
  requirementTabSelector: '',
  // 需求文档条目的 CSS 选择器（在项目/需求列表中）。为空时启用启发式探测。
  requirementDocSelector: '',
  // 文档正文章节选择器（需求文档内容区域）。为空时用启发式提取正文。
  docBodySelector: '',
  // 需求文档标题选择器（文档页内的标题）。
  docTitleSelector: '',
  // 文档条目链接属性：'href' 或 'data-id' 等，用于拼接/识别。
  docLinkAttr: 'href',
  // 需求文档链接 href 特征（启发式）。蓝湖需求文档路径通常含 requirement 或 doc。
  docHrefKeywords: ['requirement', 'docId', '/doc/'],
  // 文档标题文本特征（启发式）：页面/条目文本中包含这些关键词才视为需求文档。
  docTextKeywords: ['需求'],
};

// 读取可选配置文件（与脚本同目录）
const configPath = join(__dirname, 'lanhu.config.json');
let config = { ...DEFAULT_CONFIG };
if (existsSync(configPath)) {
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(configPath, 'utf-8')) };
  } catch (e) {
    console.warn(`[warn] 配置文件解析失败，使用默认配置: ${configPath} — ${e.message}`);
  }
}

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const args = { url: null, out: 'lanhu-export-output', discover: false, headful: false, docSelector: null, profile: null, login: false };
  const extra = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--discover') args.discover = true;
    else if (a === '--headful') args.headful = true;
    else if (a === '--doc-selector') args.docSelector = argv[++i];
    else if (a === '--profile') args.profile = argv[++i];
    else if (a === '--login') args.login = true;
    else if (!a.startsWith('--')) args.url = a;
    else extra.push(a);
  }
  return { ...args, docSelector: args.docSelector || config.requirementDocSelector };
}

const args = parseArgs(process.argv.slice(2));

if (!args.url) {
  console.error('错误：缺少蓝湖 URL。用法：node export-lanhu.mjs <蓝湖URL> [--out <目录>] [--discover]');
  process.exit(1);
}

const PROFILE_DIR = args.profile || join(homedir(), '.lanhu-skill', 'chrome-profile');
const OUT_DIR = resolve(args.out);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForAny(page, selectors, timeout = 15000) {
  for (const sel of selectors) {
    try {
      if (sel && await page.locator(sel).first().waitFor({ state: 'visible', timeout: timeout })) return sel;
    } catch { /* 继续尝试下一个 */ }
  }
  return null;
}

// 检测蓝湖安全机制横幅：打开过"分享"页后，用户状态变化，页面提示"请重新登录"。
// 此时无登录表单，但仍未真正登录，需强制重新认证。
async function hasReloginBanner(page) {
  try {
    const t = await page.evaluate(() => document.body.innerText || '');
    return /请重新登录|用户状态发生变化|为安全起见/.test(t);
  } catch { return false; }
}

async function ensureLogin(page) {
  // 若检测到登录表单、仍停留在 SSO/登录页，或出现"请重新登录"安全横幅，则切换为可见窗口并提示用户手动登录。
  const isOnLoginPage = () => {
    const u = page.url();
    return u.includes('/sso/') || u.includes('/login') || u.includes('login');
  };
  const loginSel = await waitForAny(page, config.loginIndicators, 4000).catch(() => null);
  if (loginSel || isOnLoginPage() || await hasReloginBanner(page)) {
    console.log('\n========================================');
    console.log('  检测到未登录：请在弹出窗口中手动登录蓝湖。');
    console.log('  登录完成后，脚本会自动继续（等待最长 5 分钟）。');
    console.log('========================================\n');
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      const stillLogin = await waitForAny(page, config.loginIndicators, 1000).catch(() => null);
      if (!stillLogin && !isOnLoginPage() && !await hasReloginBanner(page)) {
        console.log('登录成功，继续…');
        return true;
      }
    }
    console.error('错误：等待登录超时（5 分钟）。请重试。');
    process.exit(2);
  }
  return false;
}

// 仅登录模式：打开浏览器，等待用户完成登录后保存会话并退出。
async function loginOnly(page) {
  console.log('\n========================================');
  console.log('  蓝湖登录助手');
  console.log('  请在浏览器窗口中登录蓝湖。登录成功后脚本会自动退出并保存会话。');
  console.log('  等待最长 5 分钟…');
  console.log('========================================\n');
  // 先清除 cookie：蓝湖"分享页安全机制"会使旧会话失效（页面横幅"请重新登录"但无登录表单，
  // 会被误判为已登录）。清 cookie 后重载，强制弹出真实登录页。
  console.log('  清除旧会话 cookie，强制重新认证…');
  try { await page.context().clearCookies(); } catch {}
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  const isOnLoginPage = () => {
    const u = page.url();
    return u.includes('/sso/') || u.includes('/login') || u.includes('login');
  };
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const stillLogin = await waitForAny(page, config.loginIndicators, 1000).catch(() => null);
    if (!stillLogin && !isOnLoginPage() && !await hasReloginBanner(page)) {
      console.log('✔ 登录成功，会话已保存。');
      return true;
    }
    if (i % 6 === 0) console.log(`  …仍在等待登录（${Math.round((i + 1) * 5 / 60 * 10) / 10} 分钟）`);
  }
  console.error('错误：等待登录超时（5 分钟）。');
  process.exit(2);
}

// 对页面做“结构发现”：打印所有可点击链接与可见文本，帮助定位需求文档选择器。
async function dumpPageStructure(page) {
  console.log('\n===== 页面结构发现 =====');
  console.log('当前 URL:', page.url());
  const data = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href], a, [role="button"], [class*="item"], [class*="doc"], [class*="requirement"], [class*="nav"], [class*="menu"], [class*="tab"]'))
      .slice(0, 400)
      .map(el => {
        const href = el.getAttribute('href') || el.getAttribute('data-id') || '';
        const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60);
        const cls = (el.className || '').toString().slice(0, 60);
        return { tag: el.tagName, href, text, cls };
      });
    // 仅保留有文本或 href 的
    const meaningful = links.filter(l => l.text || l.href);
    // 去重（按 text|href）
    const seen = new Set();
    const uniq = meaningful.filter(l => {
      const k = l.text + '|' + l.href;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const bodyText = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 2500);
    return { links: uniq, bodyText };
  });
  console.log('--- 候选条目（含导航/菜单/tab，去重，最多 400 个）---');
  data.links.forEach((l, i) => {
    if (l.text || l.href) console.log(`[${i}] <${l.tag}> "${l.text}" | href=${l.href} | class=${l.cls}`);
  });
  console.log('\n--- 页面正文预览 ---');
  console.log(data.bodyText);
  console.log('\n===== 结构发现结束 =====');
}

// 启发式：在列表中找出需求文档候选条目（元素），返回 { el, title, href } 数组。
async function discoverDocEntries(page) {
  const docSelector = args.docSelector || config.requirementDocSelector;
  if (docSelector) {
    const loc = page.locator(docSelector);
    const count = await loc.count();
    const out = [];
    for (let i = 0; i < count; i++) {
      const el = loc.nth(i);
      const title = (await el.innerText().catch(() => '')).trim().replace(/\s+/g, ' ');
      const href = await el.getAttribute(config.docLinkAttr).catch(() => '');
      out.push({ el, title, href });
    }
    return out;
  }

  // 启发式：收集页面内所有链接，筛选出 href 或文本符合需求文档特征的。
  const cands = await page.evaluate((cfg) => {
    const seen = new Set();
    const res = [];
    const all = document.querySelectorAll('a[href], a');
    for (const a of all) {
      const href = a.getAttribute('href') || '';
      const text = (a.innerText || '').trim().replace(/\s+/g, ' ');
      const lower = href.toLowerCase();
      const matchHref = cfg.docHrefKeywords.some(k => lower.includes(k));
      const matchText = text && cfg.docTextKeywords.some(k => text.includes(k));
      if ((matchHref || matchText) && !seen.has(text + '|' + href)) {
        seen.add(text + '|' + href);
        res.push({ title: text, href, index: res.length });
      }
    }
    return res;
  }, { docHrefKeywords: config.docHrefKeywords, docTextKeywords: config.docTextKeywords });

  // 将候选转成 Playwright locator：按 href 定位
  const out = [];
  for (const c of cands) {
    try {
      const loc = page.locator(`a[href="${c.href}"]`).first();
      out.push({ el: loc, title: c.title, href: c.href });
    } catch { /* 忽略 */ }
  }
  return out;
}

// 从文档页提取标题与正文（多策略回退）。
async function extractDocContent(page) {
  const titleSel = config.docTitleSelector;
  const bodySel = config.docBodySelector;
  let title = '';
  if (titleSel) title = (await page.locator(titleSel).first().innerText().catch(() => '')).trim();
  let body = '';
  if (bodySel) {
    body = (await page.locator(bodySel).first().innerText().catch(() => '')).trim();
  }
  if (!body) {
    // 回退：取主内容区。尝试常见内容容器。
    const fallbacks = ['main', '[class*="content"]', '[class*="doc"]', '[class*="detail"]', 'article', '#app'];
    for (const s of fallbacks) {
      try {
        const loc = page.locator(s).first();
        if (await loc.count()) {
          body = (await loc.innerText().catch(() => '')).trim();
          if (body.length > 50) break;
        }
      } catch { /* 忽略 */ }
    }
  }
  if (!title) title = (await page.title()).replace(/[-_|].*$/, '').trim();
  return { title: title || '未命名需求文档', body };
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled';
}

async function main() {
  console.log('蓝湖需求文档导出工具');
  console.log('  目标 URL :', args.url);
  console.log('  输出目录 :', OUT_DIR);
  console.log('  配置目录 :', PROFILE_DIR);

  mkdirSync(OUT_DIR, { recursive: true });

  // 使用系统 Chrome 持久化上下文，登录态会保留在 PROFILE_DIR。
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: !args.headful && !args.discover && !args.login, // login/discover 需要可见窗口
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(15000);

  try {
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    if (args.login) {
      // 登录模式：等待用户登录后保存会话并退出
      await loginOnly(page);
      await context.close();
      return;
    }

    await ensureLogin(page);

    if (args.discover) {
      await dumpPageStructure(page);
      await context.close();
      return;
    }

    console.log('\n开始发现需求文档…');
    const entries = await discoverDocEntries(page);

    if (!entries.length) {
      console.warn('\n未在页面中发现需求文档条目。');
      console.warn('请改用 --discover 查看页面结构，确认正确的选择器，');
      console.warn('然后通过 --doc-selector "<CSS>" 或 scripts/lanhu.config.json 指定。');
      await context.close();
      process.exit(3);
    }

    console.log(`发现 ${entries.length} 篇需求文档，开始逐篇导出…\n`);
    let saved = 0;
    for (const entry of entries) {
      const display = entry.title || entry.href || '未知';
      console.log(`  处理：${display}`);
      try {
        // 点击进入文档（若条目本身是链接且有 href 且非当前页，用 goto；否则 click）
        if (entry.href && entry.href.startsWith('http')) {
          await page.goto(entry.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } else {
          await entry.el.click();
          await sleep(1500);
        }
        const { title, body } = await extractDocContent(page);
        const fname = sanitizeFilename(title);
        const filePath = join(OUT_DIR, `${fname}.md`);
        const md = `# ${title}\n\n> 来源：${args.url}\n\n${body}\n`;
        writeFileSync(filePath, md, 'utf-8');
        console.log(`    ✔ 已导出 → ${filePath}`);
        saved++;
        // 返回列表页（若条目是 href 型，无需；否则回退）
        if (!entry.href || !entry.href.startsWith('http')) {
          await page.goBack().catch(() => {});
          await sleep(1000);
        }
      } catch (e) {
        console.warn(`   ✘ 导出失败：${e.message}`);
      }
    }

    console.log(`\n完成：成功导出 ${saved}/${entries.length} 篇需求文档到 ${OUT_DIR}`);
  } finally {
    await context.close();
  }
}

main().catch(e => {
  console.error('运行出错：', e);
  process.exit(1);
});

---
name: lanhu-export
description: 通用蓝湖（lanhuapp.com）原型导出工具——逐页截图生成设计文档，或镜像为本地可交互 Axure 原型（内容与蓝湖一致），支持批量导出。Use when the user provides a Lanhu URL and wants the prototype pages exported as a design document or mirrored into a local interactive prototype.
---

# 蓝湖导出 (lanhu-export)

一个**通用**的蓝湖原型导出技能。它本身**不存储任何用户数据**——蓝湖地址、版本清单、导出目录都由使用者在调用时提供，产出写到使用者指定的目录（不要放进本技能目录）。

蓝湖页面是登录后访问的 SPA，需先登录。

## 前置条件

- 已安装 **Node.js** 与 **Google Chrome**（脚本用 `channel: 'chrome'` 驱动系统 Chrome，不需要 `npx playwright install`）
- 依赖：`scripts/node_modules`（`playwright`）。**可删除后分享**——对方在 `scripts/` 下运行 `npm install` 即可恢复（由 `package-lock.json` 锁定版本）
- 首次使用登录一次（登录态存于 `~/.lanhu-skill/chrome-profile`，不影响日常 Chrome）：
  ```bash
  node scripts/export-lanhu.mjs "<蓝湖URL>" --login
  ```

## 分享给他人

```bash
# 1. 复制技能目录，删除依赖与本地产物（node_modules 19MB 可再生）
cp -r lanhu-export lanhu-export-share
rm -rf lanhu-export-share/scripts/node_modules
# 2. 对方在 scripts/ 下重建依赖
cd lanhu-export-share/scripts && npm install
# 3. 需要本机装有 Node.js 与 Google Chrome
```
分享内容：`SKILL.md` + `scripts/`（`*.mjs`、`package.json`、`package-lock.json`、`lanhu.config.example.json`）。`node_modules` 与任何用户数据（版本清单、导出产物、`lanhu-export-output/`）都不要分享。

## 提供的工具（scripts/）

| 工具 | 作用 |
|---|---|
| `export-lanhu.mjs` | 登录（`--login`）、结构发现（`--discover`）、需求文档导出 |
| `export-prototype.mjs` | 逐页截图 → 设计文档 HTML（所见即所得） |
| `mirror-axure.mjs` | 镜像为本地**可交互 Axure 原型**（内容与蓝湖完全一致） |
| `batch-mirror.mjs` | 批量镜像多个版本，每个版本独立文件夹 |
| `verify-all.mjs` | 校验离线原型渲染（需先起 `serve.mjs`） |

## 用法

### A. 设计文档（静态截图）
```bash
cd scripts
node export-prototype.mjs "<蓝湖URL>" --out "/你的目录/原型导出"
# 输出：原型导出/设计文档.html + images/*.png + manifest.json
```

### B. 离线可交互原型（Axure 镜像）
```bash
cd scripts
node mirror-axure.mjs "<蓝湖URL>" --out "/你的目录/原型离线版"
cd "/你的目录/原型离线版" && node serve.mjs
# 浏览器打开 http://localhost:8765
```

### C. 批量（多个版本，每版本独立文件夹）
准备一个版本清单 `versions.tsv`，每行 `版本名<TAB>URL`（放在你的工作目录，不是技能里）：
```bash
cd scripts
node batch-mirror.mjs "/你的目录/versions.tsv" "/你的目录/蓝湖版本导出"
# 可选第三个参数为起始序号，支持断点续跑（已完成的版本自动跳过）
```

## mirror-axure 关键实现要点

- **Service Worker 干扰**：蓝湖用 SW 缓存，会吞掉网络请求导致镜像不全。脚本会在点击前注销 SW + 清空缓存。
- **用 `page.on('response')` 捕获**每个实际加载的资源，保存到 `mirror/<host>/<path>`。
- **捕获渲染后 DOM**（`frame.evaluate(() => document.documentElement.outerHTML)`）替换服务端原始 HTML，配合本地资源即可离线重渲染。
- **补漏**：扫描 HTML/JS/CSS 引用，用认证 `context.request` 直接抓缺失资源（绕过缓存）。
- **重写跨域引用**：`alistatic.lanhuapp.com`、`axure-file-readonly.lanhuapp.com` → 本地相对路径。
- **自动打开文档回退**：若页面树为空（部分版本需先进入 `.rp` 产品文档），脚本会自动点击打开。

## 常见问题

- **未登录**：先 `--login` 登录一次。
- **打开过"分享"页面后失效**：蓝湖安全机制会提示重新登录，需重新 `--login`。
- **index.html 直接双击打不开**：必须用 `node serve.mjs` 经本地服务器访问（iframe 跨域限制）。
- **导出数据**：始终写到技能目录之外（如 `/你的目录/`），保持技能通用、无用户数据。

## 备注

- 仅导出使用者有权限访问的项目内容。
- 本技能定位为通用工具；用户数据（地址清单、导出产物）一律存放在技能目录之外。

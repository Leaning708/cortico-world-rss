# 开发与发布

面向二次开发和贡献者。用户使用说明见 [README](../README.md)，设计背景见 [design.md](design.md)。

## 环境

- Node.js ≥ 22
- pnpm（版本见 `package.json` 的 `packageManager`）
- 面板开发需要浏览器；完整验收需要本机 Coopanion

本机没有全局 Node 时，把 DSH 运行时里的 `node/bin` 加入 `PATH` 再执行命令。

## 常用命令

```bash
corepack pnpm install
pnpm typecheck      # 服务端 + 浏览器面板两份 tsconfig
pnpm test           # 先构建面板，再跑 vitest（不访问真实网络）
pnpm describe:local # 重新生成 describe.json（改工具/事件/提示词后必须跑）
pnpm build:webui    # 只重建 dist/webui.js
pnpm feed-server    # 本地 RSS 测试服务器，http://127.0.0.1:8787
```

## 测试

- 单元测试全部使用注入的 `fetchImpl`，不访问真实网络。
- 真机集成测试默认跳过；需要时加环境变量：

  ```bash
  RSS_LIVE_TEST=1 npx vitest run tests/live.test.ts
  ```

- 改了工具、事件、环境提示词或 `promptDocs` 后，必须重新生成 `describe.json`；测试会逐字比对代码声明与 `describe.json`。
- 面板产物按版本 URL 以 `immutable` 缓存提供：**改了面板就要 bump patch 版本**，再构建、重启、换新 URL 目检。

## 项目结构

| 路径 | 职责 |
|---|---|
| `src/config.ts` | 配置接口、默认值、JSON Schema、面板分组 |
| `src/config-save.ts` | 面板保存通道：白名单、数值钳制、整单校验 |
| `src/store.ts` | 订阅源与条目库（双 JSON、原子写、清理、基线语义） |
| `src/parse.ts` | RSS 2.0 / Atom / RDF 归一化、去重键、站点 feed 发现 |
| `src/fetcher.ts` | 条件请求、重定向校验、体积/超时上限、编码探测 |
| `src/poller.ts` | 调度、退避、合批缓冲、订阅首拉与基线 |
| `src/extract.ts` | 文章正文抽取（`rss_read(full)`） |
| `src/chrono.ts` | 时区时间：晨报时刻、相对时间 |
| `src/opml.ts` | OPML 导入导出 |
| `src/world.ts` | 7 个工具、3 个事件、面板数据面、启动播报 |
| `src/definition.ts` | WorldDefinition 与 `ctx.persist` 通道 |
| `src/strings.ts` | 中英文案，两份结构必须对称 |
| `src/webui/client.ts` | 浏览器面板：订阅源 / 收件箱 / 通知 / 高级 / OPML |
| `src/ENV_PROMPT.md` | 环境提示词 |
| `describe.json` | 自描述产物，由代码生成，随包提交 |

更详细的契约与实现说明见 [design.md](design.md)。

## 本地测试服务器

```bash
pnpm feed-server   # http://127.0.0.1:8787
```

端点：

- `/rss.xml`（RSS 2.0，带 ETag/304）、`/atom.xml`、`/gbk.xml`
- `/site`（站点自动发现）、`/broken.xml`、`/error/404`
- `POST /publish {"feed":"rss","title":"新消息"}` 注入新条目

## 调试版本

面板产物按版本 URL 做 `immutable` 缓存，所以开发期用预发布版本换缓存键：

```bash
pnpm bump:dev        # 0.3.0-dev.1 -> 0.3.0-dev.2；从 0.3.0 开始则 -> 0.3.0-dev.1
```

- 只有面板改动需要递增；纯后端改动重启即可，不必改版本。
- 发布前把版本改回 `X.Y.Z`（去掉 `-dev.N`）；`-dev.N` 版本不发布、不打 tag。
- 不要用四段号 `X.Y.Z.N`（不是合法 SemVer，npm 不接受）。

## 版本与发布记录

项目不在仓库内维护 `CHANGELOG` 文件。每个对外版本用 **GitHub Release** 记录变更，`package.json` 版本、git tag、Release 标题保持一致。

- 开发期不需要逐次记录版本；提交信息写清改动即可。
- 发布说明面向用户写功能、行为变化与修复，不写内部实现流水账。
- 没装 `gh` CLI 时，直接在 GitHub 仓库的 **Releases → Draft a new release** 页面选 tag、写标题和说明即可。

## 发布流程

1. 确定发布版本，把 `package.json` 从调试版 `X.Y.Z-dev.N` 改回 `X.Y.Z`。
2. `pnpm typecheck`、`pnpm test`；确认 `describe.json` 与代码一致。
3. 本机安装/重启 Coopanion，按面板目检；面板有改动时先 bump patch 版本。
4. 在 Cortico 检出根跑发布检查：

   ```bash
   pnpm describe:extension <本包目录>
   pnpm check:extension  <本包目录>
   ```

5. 提交代码、打 tag（如 `v0.2.1`）、推送 GitHub。
6. 在 GitHub 创建对应版本的 **Release**，写发布说明（这就是本项目的“changelog”）。已装 `gh` 时可：`gh release create vX.Y.Z --title vX.Y.Z --notes-file notes.md`；否则用网页。
7. `npm publish`（官方 registry，按账号需要 2FA；如进入 staged publishing，需在 CLI 或 npmjs.com 批准）。
8. 发布后同步国内镜像：

   ```bash
   curl -X PUT "https://registry.npmmirror.com/-/package/<包名>/syncs"
   curl "https://registry.npmmirror.com/-/package/<包名>/syncs/<id>"   # 轮询到 success
   ```

   镜像元数据同步后搜索索引仍可能滞后；需要立刻在市场可见时，可把 Coopanion 的扩展 npm 源切到 `https://registry.npmjs.org`。
9. 首次发布新包时建议到 `Pal-AI-Lab/cortico-extensions` 开 `[sync] <包名>` issue，让市场立刻收录；后续新版本市场会定时同步，着急时再开即可，不必每次发版都开。

更完整的发布/面板/重启/目检规范见本仓库 skill：`.agents/skills/coopanion-plugin-dev/`。

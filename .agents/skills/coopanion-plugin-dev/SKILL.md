---
name: coopanion-plugin-dev
description: 给桌宠 Coopanion（基于 Cortico 框架）开发、改造、验收扩展插件的完整闭环 skill：读官方文档 → 与用户确认范围与接口/网络/文件 → 从模板实现 → 做 WebUI 面板 → typecheck/test → 重启 Coopanion → 受控浏览器目检 → 本机目录安装交付。合并了原 coopanion-extension、coopanion-panel-ui、coopanion-webui-debug、restart-coopanion 四个 skill。用于"给 Coo 写个扩展/插件"、"接入某个外部服务/游戏/平台"、"改扩展面板 UI / 新建面板 / 界面丑 / 不对齐 / 按钮不像按钮 / 配置项太挤 / 配置做成标签或弹框"、"你自己看一下界面 / 截图给我"、"重开或关掉再打开 Coopanion / 重启 / 让改动生效"、"review 或修一个 cortico-world-* 包"。
whenToUse: 用户想给 Coopanion / Cortico 开发、评审或排障一个扩展包（World、provider、bot），要改它的 WebUI 面板、要看界面效果、或要让扩展改动生效时。
---

# Coopanion 插件开发（扩展 + 面板 + 目检 + 重启）

Coopanion 用 [Cortico](https://github.com/Pal-AI-Lab/Cortico) 框架组装；扩展就是 Cortico 的扩展：一个 npm 包，给 Coo 补一个 **World**（一个新的「世界」，比如 QQ、游戏、智能家居）、一个模型服务（**provider**）或一个 **bot**。

扩展与形象包不同：形象包关在沙箱里，**扩展直接跑在 Coopanion 的核心进程里**，能做的事多得多。所以：先确认再动手、只做确认过的功能、不读取或上传用户的隐私数据与 API Key、用到别人的代码或素材时注明来源与许可证。

本 skill 把"写扩展 → 做面板 → 重启生效 → 目检界面"串成一条闭环：

| 阶段 | 内容 | 旧 skill 名（已并入本文件） |
|---|---|---|
| A | 需求确认与方案 | `coopanion-extension` |
| B | 从模板实现（World / provider / bot） | `coopanion-extension` |
| C | 面板 UI 与配置保存 | `coopanion-panel-ui`（详见 `references/panel-ui-spec.md`、`references/ui-components.md`） |
| D | 构建与测试 | `coopanion-extension` |
| E | 重启 Coopanion 生效 | `restart-coopanion`（脚本 `scripts/restart.ps1`） |
| F | 受控浏览器目检 WebUI | `coopanion-webui-debug`（脚本 `scripts/find-webui-port.sh`） |
| G | 交付：本机目录安装 / 发布边界 | `coopanion-extension` |

> 位置约定：项目内 skill 统一放 `.agents/skills/<name>/`；仓库里的 `.dsh/skills` 与 `.claude/skills` 是指向 `.agents/skills` 的软链（让 DSH / Claude Code 等不同 agent 都按各自约定读到同一份），`CLAUDE.md` 软链到 `AGENTS.md`。脚本路径示例都用 `.agents/skills/coopanion-plugin-dev/scripts/…`。

## 0. 三条铁律（先记这三条，再往下读）

1. **面板改动只 bump 开发预发布位，发布时才去掉后缀**。面板产物按 `/assets/extensions/<包>/<版本>/webui.js` 以 `Cache-Control: public, max-age=31536000, immutable` 提供——同一版本号内的任何改动，重启进程、换源都到不了浏览器。开发期用 `X.Y.Z-dev.N`（可用 `pnpm bump:dev` 递增），纯后端改动不必 bump；发布时改回 `X.Y.Z`、打同名 tag、写 GitHub Release。禁止四段号 `X.Y.Z.N`（不是合法 SemVer）。
2. **构建产物随包提交，`link:` 本机扩展必须重启进程才生效**：`describe.json`、`dist/webui.js` 是提交进包的文件；改代码后不重启 Coopanion，扩展还是旧代码。
3. **测试不碰真实网络，"测试全绿"必须真跑过**：外部行为通过注入的 `fetchImpl` / `createSocket` / `resolve` 模拟；不为了让测试变绿而删断言或跳过用例。

标准闭环（面板迭代就是 C→D→E→F→C 的循环）：

```
A 确认范围与方案 → B 模板实现 → C 面板 UI → D 构建与测试
                                              │
                  G 交付 ← F 目检 ← E 重启 Coopanion
```

## 阶段 A：先读文档，再和用户确认（旧 coopanion-extension）

### A.1 官方提示词（原文，本 skill 的基线，逐字保留）

> 我想给桌宠 Coopanion（基于 Cortico 框架）写一个扩展。请先读完这几份资料：
> - 指南的「写扩展」：https://coo.palailab.org/guide/make-extension/
> - Cortico 的扩展文档：https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md
> - 扩展模板：https://github.com/Pal-AI-Lab/Cortico/tree/main/templates/extension
>
> 然后和我一步步商量着写：
> 1. 先问清楚我想让这个扩展做什么，它是 World、provider 还是 bot，需要连接哪些外部服务。一次问几个就好。
> 2. 给出方案：用到哪些接口、要声明什么、会访问哪些网络地址和文件。我确认后再动手。
> 3. 从对应的模板复制一份开始写，包名和 id 按文档的规则取；World 扩展的 package.json 要带上 `cortico-world` 关键字。
> 4. 写完运行 `corepack pnpm install` 和 `pnpm test`，测试全部通过再交给我。
> 5. 告诉我怎么在 Coopanion 的扩展页从本机目录装上它试用。不要替我发布到 npm，发不发由我自己决定。
>
> 要求：只做我确认过的功能；不要读取或上传我的隐私数据和 API Key；用到别人的代码或素材时，注明来源和许可证。

### A.2 必读资料（开始问问题之前真正读完）

| 资料 | 用途 |
|---|---|
| <https://coo.palailab.org/guide/make-extension/> | 用户视角：模板、发布、市场收录 |
| <https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md> | 扩展总契约：安装、更新、自描述、校验、契约版本、三类扩展写法 |
| <https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/worlds.md> | World 契约：`WorldDefinition` / `World` / `WorldHost`、事件 trigger、配置热生效、环境提示词 |
| <https://github.com/Pal-AI-Lab/Cortico/tree/main/templates/extension> | 三种 kind 的可安装模板（`world/`、`provider/`、`bot/`） |

### A.3 问用户（按需挑 2–3 个，一次不要抛一堆）

1. 这个扩展要让 Coo 做什么？只读观察，还是要操作外部世界？
2. 外部服务是什么？有没有官方 API/WebSocket？鉴权方式（API Key、OAuth、设备码、长期令牌、无鉴权）？
3. 它会访问哪些网络地址、哪些本机文件/端口？数据里有没有隐私（设备、位置、聊天、账号）？
4. 需要主动推事件（状态变化）吗，还是只靠工具查询？
5. 有没有必须"先确认再执行"的危险操作？
6. 是否需要自定义 WebUI 面板（比如粘贴令牌、显示状态）？
7. 现在只本机试用，还是准备发布到 npm？

拿不准 kind 时按这个判据：

- **World**：给 Coo 补一个外部世界（平台、游戏、智能家居、命令行输出……），提供工具 + 事件 + 环境提示词。
- **provider**：接入一个模型端点（LLM API），需要协议、密钥、多模态/上下文能力声明。
- **bot**：一整套人格（Persona/Memory/工具），会替换 Coo 的身份，只有用户明确要"换一个 bot"时才选。

### A.4 方案先行（用户确认后才写代码）

方案里必须写清：

- **kind 与 id**：`id` 同时用于配置段 `worlds.<id>` 和 WebUI 页 `world:<id>`；不能与内建 World 冲突（内建：`console`、`qq`、`bilibili`、`minecraft`、`websearch`、`webui-fixture`）。
- **包名**：`cortico-<kind>-<名字>`，小写 kebab-case；`keywords` 必须含对应类关键字（`cortico-world` / `cortico-provider` / `cortico-bot`）。**先查 npm 是否已被占用**（`https://registry.npmjs.org/<包名>`，404 才可用）；本机目录安装不查 npm，但发布时同名会 403。
- **契约版本**：`cortico.api` —— world **6**、provider **6**、bot **7**，写错不能加载。
- **工具表**：每个工具的名字、参数 JSON Schema、回执形状、失败语义、`tags`（`read` / `act`）、截断上限。
- **事件表**：`type`、`origin`（`external` / `internal`）、`trigger`（默认 `debounce`）、正文长度上限。
- **配置项**：每个键的类型/默认值/是否热生效（标 `x-hot`）；配置路径必须落在自己的段内，且 `defaults()` 里有对应项。
- **网络**：列全要访问的地址（域名、端口、协议），说明不访问其它地址、无遥测。
- **文件**：读哪些、写哪些；令牌/密钥只走 `ctx.secret()` / `ctx.storeSecret()`，不进 `config.json`、不回显、不进日志。
- **隐私**：哪些数据会进入模型上下文（这是必然的，要如实告知用户）。
- **危险动作**：哪些操作需要二次确认（删除、付款、开锁、执行命令、发消息）。

工具名在一个 bot 内全局唯一：用自家短前缀（如 `ha_`、`qq_`），并集中声明在 `<PREFIX>_TOOL_DECLS`（不含 handler），`tools()` 在其上加 handler，`describe.tools` 用 `describeTools(<PREFIX>_TOOL_DECLS, summaries)` 从同一份声明生成——**一份声明三处复用**。

## 阶段 B：从模板复制，别从零搭（旧 coopanion-extension）

```bash
# 复制对应 kind 的模板（world 为例）
cp -r <cortico>/templates/extension/world ./cortico-world-<name>
cd cortico-world-<name>
# 改 package.json：name、description、cortico.displayName/icon/locales、keywords
# 改 src/index.ts 的 WorldDefinition：id / label / defaults / create / describe
corepack pnpm install
```

要点（漏一个就装不上或报错）：

- `"type": "module"` 是硬要求；`main` 直接指 `./src/index.ts`（宿主用 tsx 跑）。
- 开发依赖装 `cortico`（`corepack pnpm add -D cortico`）：只给编辑器、`tsc`、`vitest` 用；运行时由宿主的模块钩子解析到框架自身。
- `describe` 指向包内 `describe.json`，且 `files` 要包含它；改工具/事件/提示词后重新生成（见阶段 D）。
- 有自定义面板：`src/webui/client.ts` 默认导出 `{ panels: { <id>: { mount(ctx) } } }`，用 esbuild 打成 `dist/webui.js`（可加 `.css`），路径写进 `cortico.webUiClient`，`files` 要包含 `dist`，产物要提交进包（见阶段 C）。
- World 的 `enabled` 默认必须为 `false`；装配层会为**未启用**的 World 创建实例，所以构造必须能在"默认配置 + 无密钥"下成功。
- 环境提示词放 `src/ENV_PROMPT.md`，用 `webUi().promptDocs` 声明，通过 `envPromptVars()` 提供占位变量。
- 浏览器侧对 `cortico/*` 只能 `import type`；面板只经 `ctx.invoke` 与宿主通信。

## 阶段 C：面板 UI（旧 coopanion-panel-ui）

**动手前必须先读**：

- `references/panel-ui-spec.md` —— 页面结构、7 条布局硬规则、弹框（抽屉）、配置保存通道、交付检查、中文标点规范。
- `references/ui-components.md` —— `ctx.ui.*` 组件实测行为与坑（variant 只有三种、table 对齐、checkbox 提示标记的 flex 坑、版本缓存）。

先记住这几条最常翻车的：

1. **面板即标签**：`webUi().panels[]` 的每个 panel 就是 World 页的标签；不声明 `config` 组，内建「配置」标签自动消失，配置自己做表单标签，保存走 `invoke('config.save', [patch])`。
2. **概览读数用独立小卡片**：一卡一类、窄而高（`flex: 0 0 230px`）、上下 16px 内边距，内联补 `border` / `border-radius` / `background`（sheet 默认只有上边框，没有盒子感）。
3. **筛选靠左、动作按钮靠右**，中间 `ctx.ui.h('div', 'grow')` 占位；主操作用 `variant: 'primary'`（plain 在暗色主题下几乎看不出是按钮）。
4. **表格对齐**：长列表 `maxHeight`（粘性表头）+ colgroup + `table-layout: fixed`；文本列左对齐、徽标/计数/状态列水平居中（表头与内容同规则）；所有列 `verticalAlign: 'middle'`，行内 rowbar 的 `margin-bottom` 清零。
5. **弹框**：短字段两两并排、地址类长输入才占全宽；布尔项用 `ctx.ui.checkbox(label)`；操作期间 `ctx.ui.disable(...)`，结束 dispose 恢复。

服务端配置保存必须是**纯函数校验模块**（键白名单 + 数值钳制 + 格式校验 + 整单拒绝 → 写活配置 + `ctx.persist(patch)` 落 config.json），返回 `{ ok, restartRequired, applied }`；只有参与构造的键才标 `restartRequired`。

中文（zh）文案直接用全角标点；已有混用时用本 skill 自带脚本清扫（预览确认后再 `--apply`；路径按安装位置选一种，仓库内安装在项目根下用 `.agents/skills/coopanion-plugin-dev`，用户级安装用 `~/.agents/skills/coopanion-plugin-dev`）：

```bash
# 仓库内安装（示例）
node .agents/skills/coopanion-plugin-dev/scripts/normalize-punct.mjs src/strings.ts src/world.ts
node .agents/skills/coopanion-plugin-dev/scripts/normalize-punct.mjs src/strings.ts src/world.ts --apply
```

面板一改就要走铁律 1：**bump patch 版本 → 构建（`pnpm test` 会先 esbuild 面板）→ 阶段 E 重启 → 阶段 F 目检**，否则浏览器永远拿旧包。

## 阶段 D：构建与测试（旧 coopanion-extension）

```bash
corepack pnpm install
pnpm typecheck      # 有面板时通常是两份 tsconfig（Node 侧 + web 侧）
pnpm test
```

- 测试必须**不依赖真实网络**：给 REST/WS 注入假实现（`fetchImpl`、`createSocket`），用 `FakeHost` 记录 `pushEvent`。
- 覆盖：无密钥时的回执、每个工具的正常/拒绝路径、事件白名单与去重、连接失败/鉴权失败/重连、`describe.json` 与代码逐字一致、WebUI 产物存在。
- 有 Cortico 检出时再跑（**发布前必须**）：

```bash
pnpm describe:extension <包目录>   # 生成/刷新 describe.json
pnpm check:extension <包目录>      # 校验 manifest、默认导出、构造与自描述
```

- 改了工具/事件/`ENV_PROMPT`/`promptDocs` 的 title → 必须重跑 `describe:extension`（或仓库脚本 `describe:local`），`describe.json` 由代码生成，手工改无效。
- 测试不过不要交付；不要为了让测试变绿而删断言或跳过用例。

## 阶段 E：重启 Coopanion 让改动生效（旧 restart-coopanion）

Coopanion 是 Electron 桌面应用（`%LOCALAPPDATA%\Programs\Coopanion\Coopanion.exe`）。本机目录以 `link:` 写入扩展工作区，**改代码必须重启进程才生效**；交付扩展改动后主动执行本流程，不要等用户提醒。

一条命令完成"清场 → 拉起 → 验证"（路径按安装位置选：仓库内安装用 `.agents/skills/coopanion-plugin-dev`，用户级安装用 `~/.agents/skills/coopanion-plugin-dev`）：

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .agents/skills/coopanion-plugin-dev/scripts/restart.ps1
```

脚本输出 `OK: Coopanion 已重启, N 个新进程 (PID: ...)` 才算成功；输出 `FAIL` 时把原因转告用户，不要重试超过两次（连续失败说明有东西杀不掉，让用户手动处理）。

为什么这样做（踩过的坑，别再踩）：

1. **不用优雅关闭**（taskkill 不带 `/F`）：实测会留残余进程——窗口没了但后台进程活着。Electron 有单实例锁，只要还有一个旧进程存活，新实例就起不来，表现是"重启命令跑了，PID 却和重启前一样"。必须 `Stop-Process -Force` 全灭，确认归零，再拉起。
2. **必须校验 PID 换血**：重启成功的唯一证据是"新 PID 列表与旧 PID 无交集"（脚本还比对了启动时刻，防 PID 复用误判）。只数进程数不够——数到 5 个可能全是旧的。
3. **Git Bash 里调 Windows 工具要用双斜杠**（`taskkill //IM Coopanion.exe`），单斜杠会被路径转换吃掉；这也是脚本直接用 PowerShell `Get-Process`/`Stop-Process` 的原因——绕开转义和输出乱码。
4. **拉起要用 `Start-Process`**（独立进程）：如果以 shell 子进程方式启动，shell 退出时应用会跟着死。
5. **含中文的 .ps1 必须存成 UTF-8 带 BOM**：Windows PowerShell 5.1 对无 BOM 文件按 ANSI/GBK 解析，中文注释直接导致语法错误（报"意外的标记"}""这种看不出原因的错）。改脚本后如果解析炸了，先查 BOM。

前置与边界：

- 扩展改动要先构建再重启：面板产物是提交进包的 `dist/webui.js`，先跑包的构建/测试命令（通常是 `pnpm test`，它会先 esbuild），再重启。
- 重启会打断用户与 Coo 的当前会话（框架会从持久化恢复，不丢配置与事件）。交付说明里提一句即可，不必每次征求同意——用户要求"改完自动重启"时，这就是默认动作。
- 重启后要目检界面效果，走阶段 F（注意面板产物带 immutable 缓存，普通刷新会拿旧包）。
- 只动 Coopanion 自己的进程；不碰它的数据目录，不代做扩展安装。

## 阶段 F：受控浏览器目检 WebUI（旧 coopanion-webui-debug）

Coopanion 的界面就是 Cortico WebUI（Electron 只是壳），监听本地端口。**不要做屏幕级点击模拟**——用受控浏览器打开同一页面，DOM 快照定位 + 截图，可靠得多。

### F.1 找到 WebUI 端口

```bash
bash .agents/skills/coopanion-plugin-dev/scripts/find-webui-port.sh
```

输出形如 `http://127.0.0.1:17788/`。Coopanion 没运行时先走阶段 E 把它拉起来。

### F.2 浏览器流程

先加载 `browser-use:control-browser` skill，严格按它走：node_repl 引导（`ZCODE_PLUGIN_ROOT`）→ `getForUrl("<webui 基址>")` → 新标签 → `goto` 后必须 `waitForLoadState("domcontentloaded")`。（当前环境若无该 skill，就用可用的浏览器控制工具走同一流程：受控浏览器打开该 URL、等 `domcontentloaded`、DOM 快照定位、截图。）

本机实测经验：

- **路由是 hash 式**：`#/provider/world%3Arss`（= `world:<id>` URL 编码）。别猜路径，从 `domSnapshot()` 的导航链接里读真实 `/url:`。
- **快照可能超大**（整站 >200KB 会被持久化到文件）：不要整页吐回，用 `split("\n")` 定位关键词后切片，或直接找目标区域的行。
- **定位器重名**：World 页的标签按钮（通知/设置）与底部应用栏按钮同名。先收窄容器：

  ```js
  const pageTabs = tab.playwright.getByRole("navigation")
    .filter({ has: tab.playwright.getByRole("button", { name: "订阅源" }) });
  pageTabs.getByRole("button", { name: "设置" }).click();
  ```

- **抽屉/弹框**可以照常点开截图：添加表单、详情弹框都是真实 DOM，不是 canvas。

### F.3 截图

用户要看样式 = 视觉分支：先 `nodeRepl.write(await agent.documentation.get("screenshots"))`，然后每个截图必须同一单元内 `nodeRepl.emitImage(await tab.screenshot())`。视口设 `1200×820` 与桌面应用比例接近。

### F.4 ⚠️ 不可变缓存（最容易坑的一步）

改完代码、重启进程后目检，浏览器普通刷新**永远拿旧的**。按这个顺序排查：

1. **确认服务器侧是新代码**（绕开浏览器）：

   ```bash
   curl -s "http://127.0.0.1:17788/assets/extensions/<包名>/<版本>/webui.js" | grep -c "新代码里的标记字符串"
   curl -sI "…" | grep -i "last-modified\|content-length"
   ```

   资源 URL 从页面 `performance.getEntriesByType("resource")` 里读，别猜。

2. 服务器是新的、浏览器还是旧的 → **换源绕缓存**：`localhost` 与 `127.0.0.1` 是不同源、HTTP 缓存互相隔离，开新标签走 `http://localhost:<port>/#/...` 即可。
3. **服务器也是旧的 → 升开发预发布位再重启**。immutable 缓存按"版本 URL"钉死内容：同一个版本号内的后续改动，重启进程、换源都救不回来（桌面端 webview 与受控浏览器一样）。开发迭代的正确姿势是**每次改面板就用 `pnpm bump:dev` 递增 `X.Y.Z-dev.N`**——版本 URL 变了，所有缓存自然失效；发布时改回 `X.Y.Z`。改完再确认新版本 URL 返回 200 且含新代码标记。
4. 在页面里核实脚本真身：`styleAttr`/`getComputedStyle` 看元素是否带上了新样式（截图看不出来时用这招）；检查脚本 URL 是否还是旧版本号。

### F.5 收尾

- 标签留给用户看（尤其换源后的实时视图），不要顺手关；用户说不要了再关。
- 发现样式问题：按阶段 C 的规范修 → bump patch 版本 → 包内构建（通常是 `pnpm test`，会先 esbuild 面板）→ 阶段 E 重启 → 回本阶段目检闭环。

## 阶段 G：交付（旧 coopanion-extension）

### G.1 本机目录安装

1. Coopanion「扩展」页 →「手动安装」→ 选**本机目录**（包的根目录）。框架会先 `POST /api/extensions/check` 只读校验 manifest，不合格会被拒绝。
2. 安装会把它以 `link:` 写进扩展工作区（`CORTICO_EXTENSIONS_DIR`，默认部署的 `extensions/`），改代码后**重启 Coopanion 进程**生效（阶段 E）。
3. 重启后到「World 总览」/ 对应页启用它，再按 README 配好地址与密钥/令牌。
4. 卸载前要先停用（运行中的条目卸载会回 409）。

### G.2 不要替用户发布

`npm publish` 由用户自己决定。若用户要发，提醒：`keywords` 带类关键字、`cortico.api` 对、`describe.json` 在包内、GitHub 上有对应 tag 的 Release 说明、`os` 不设除非有平台限制；新包首次发布建议到 `Pal-AI-Lab/cortico-extensions` 开 `[sync] <包名>` issue，让市场立刻收录；后续新版本市场会定时同步，着急时再开即可，不必每次发版都开。

### G.3 发布后同步国内镜像（npmmirror）

Coopanion 扩展市场默认走 `https://registry.npmmirror.com`；新包/新版本**不会立即**被镜像收录。发布成功（含 staged 审核通过）后，主动触发一次同步：

```bash
# 触发；返回 {"ok":true,"id":"...","state":"waiting"}
curl -X PUT "https://registry.npmmirror.com/-/package/<包名>/syncs"

# 用返回的 id 轮询到 state=success
curl "https://registry.npmmirror.com/-/package/<包名>/syncs/<id>"
```

也可以用网页点同步：`https://npmmirror.com/sync/<包名>`。

注意：

- 镜像元数据同步后，**搜索索引仍可能滞后**。Coopanion 市场先用 `keywords:<类关键字>` 查 npm registry，镜像对这个查询可能返回空，再回退到普通文本搜索；索引没收录时仍会搜不到。
- 想立刻在 Coopanion 市场可见，可在「World 扩展 → 扩展市场」把 npm 源临时切到 `https://registry.npmjs.org`（搜索、更新、安装一起生效）；不着急就等镜像索引更新。
- **每次发版都要重复这一步**，否则国内镜像可能长期停留在旧版本或根本搜不到新包。

### G.4 版本与发布记录（GitHub Releases）

- 不强制在仓库里维护 `CHANGELOG.md`；**对外发布记录写在 GitHub Releases**，与 npm 版本、git tag 保持一致。
- 发布流程：更新版本 → 构建/测试/目检 → 提交 → 打 tag 并推送 → 在 GitHub 创建对应 Release（写用户向的功能、行为变化、修复）→ npm publish。
- 开发期用 `X.Y.Z-dev.N` 迭代，不消耗发布版本号；发布时去掉后缀成 `X.Y.Z`。
- 开发期不需要逐次记录版本；提交信息写清改动即可，不要为每次调试 patch 单独写发布说明。
- 发布说明面向用户，不写内部实现流水账；实现细节放设计文档或提交信息。

## 红线

- 只做用户确认过的功能；不顺手加"可能有用"的工具或网络请求。
- 不读取、不打印、不上传用户的隐私数据与 API Key；调试输出里出现令牌即视为事故。
- 令牌/密钥只经 `ctx.secret()` / `ctx.storeSecret()`；面板不回显；日志不含密钥；`config.json` 不存密钥。
- 只访问方案里列出的地址；不引入遥测、不 fetch 用户没同意的第三方。
- 复用他人代码/素材要确认许可证并署名（Cortico 与官方模板是 MIT，© 2026 Phantivia）；不复制未授权素材。
- 不声称"测试通过"除非真的跑过；不声称"装好了"除非用户确认过卡片与状态；不声称"界面好了"除非目检过（阶段 F）。

## 常见坑（别再踩）

| 现象 | 原因 / 修法 |
|---|---|
| 装完扩展页没有卡片 | `cortico.api` 与当前 Coopanion 不符（world 6 / provider 6 / bot 7），或 `main`/`type` 不对 |
| 卡片有了但工具不被调用 | `describe.tools` 缺工具名（运行日志在 `worlds.<id>` 下 warn），或工具名与其它 World/Persona 冲突导致装配拒绝 |
| 配置旋钮改了没反应 | 路径写在了段外，或该键构造时读入（需要 `x-hot: false` 并重启 World） |
| 面板不显示 | `webUiClient` 路径错、`dist` 没随包发布、构建产物过期 |
| 自描述校验失败 | 改了工具/事件/提示词但没重跑 `describe:extension`，或 `files` 漏了 `describe.json` |
| 面板改了、重启了，浏览器还是旧的 | immutable 缓存按版本 URL 钉死内容——bump patch 版本再重启（阶段 F.4） |
| 重启命令跑了，PID 却没变 | 旧进程没清干净 + Electron 单实例锁；必须强杀到归零再拉起（阶段 E） |
| 弹框/表格错位、按钮不像按钮、配置项太挤 | 违反面板布局硬规则，按阶段 C 与 `references/panel-ui-spec.md` 修 |
| Node 22 下 `corepack pnpm` 报 `Cannot find matching keyid` | corepack 自带密钥过期；临时用 `$env:COREPACK_INTEGRITY_KEYS='0'; corepack pnpm install`（PowerShell），不要改系统设置 |
| 装完不生效 | `link:` 本机扩展必须重启进程；只改源码不会热更 |
| 发布时 403 / 包名已存在 | 包名被别人占用（查 `https://registry.npmjs.org/<包名>`）；换名或加 scope。World 的 `id` 与 npm 包名无关，可继续用 |
| 含中文的 `.ps1` 报"意外的标记" | 文件没存成 UTF-8 带 BOM，PowerShell 5.1 按 GBK 解析 |
| Git Bash 里 `taskkill //IM` 不生效 | 单斜杠被路径转换吃掉，必须双斜杠；或直接用 PowerShell 脚本绕开 |
| 中文文案里混着半角标点 | 用 `scripts/normalize-punct.mjs` 预览后 `--apply` 清扫 |

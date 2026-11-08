# AGENTS.md — cortico-world-rss 工程指南

Coopanion(Cortico 框架)的 RSS 订阅 World 扩展。本文件面向后续在本仓库工作的 Agent 与开发者:命令、结构、变更清单、已踩过的坑。设计背景与完整契约见 `docs/design.md`(含"实现与设计的偏差对照"一节,先读它避免被过时描述误导)。

## 命令(本机没有全局 Node,用 DSH 运行时)

先把 DSH 运行时的 `node/bin` 加入 PATH(路径因机器而异,位于 `~/.dsh/dsh-runtimes/<运行时>/dependencies/` 下),然后:

```bash
node "<DSH 运行时>/dependencies/pnpm/bin/pnpm.mjs" typecheck      # 两份 tsconfig:Node 侧 + webui 面板侧
node "<DSH 运行时>/dependencies/pnpm/bin/pnpm.mjs" test           # esbuild 打面板 → vitest(不碰真实网络)
node "<DSH 运行时>/dependencies/pnpm/bin/pnpm.mjs" describe:local # 生成 describe.json(改工具/事件/提示词后必跑)
node "<DSH 运行时>/dependencies/pnpm/bin/pnpm.mjs" run feed-server  # 本地 RSS 测试服务器 http://127.0.0.1:8787
RSS_LIVE_TEST=1 npx vitest run tests/live.test.ts  # 真机集成(自起测试服务器)
```

## 文件职责速查

| 文件 | 职责 |
|---|---|
| `src/config.ts` | 配置段接口、默认值、JSON Schema、分组(设置页字段由此而来) |
| `src/config-save.ts` | 面板保存通道的纯校验:键白名单、数值钳制、格式校验、整单拒绝 |
| `src/store.ts` | 订阅源表 + 条目库(dataDir 双 JSON、原子写、compact 清理、基线语义) |
| `src/parse.ts` | RSS 2.0/Atom/RDF 归一化、去重键、实体解码、站点 feed 发现 |
| `src/fetcher.ts` | 条件请求、重定向逐跳校验、体积/超时上限、编码探测 |
| `src/poller.ts` | 调度、退避、合批缓冲、adoptFeed(订阅首拉 + baseline) |
| `src/extract.ts` | 文章正文抽取(rss_read full) |
| `src/chrono.ts` | 时区时间:晨报时刻、相对时间 |
| `src/opml.ts` | OPML 导入导出 |
| `src/world.ts` | 主体:7 工具、3 事件、面板数据面(invoke 按 method 分发)、事件投递 |
| `src/definition.ts` | WorldDefinition(persist 通道在这里接 `ctx.persist`) |
| `src/strings.ts` | zh/en 全部文案,**两份结构必须对称**(`typeof zh` 约束) |
| `src/webui/client.ts` | 浏览器面板:五个标签 = 订阅源/收件箱/通知/高级/OPML |
| `src/ENV_PROMPT.md` | 环境提示词(进 system 前缀) |
| `scripts/describe.ts` | 生成 describe.json;`scripts/feed-server.mjs` 本地测试服务器 |
| `describe.json` | 自描述产物,测试逐字比对,**改声明后必须重新生成** |
| `.agents/skills/coopanion-plugin-dev/` | Coopanion 插件开发规范 skill(原 extension/panel-ui/webui-debug/restart 四个 skill 的合并版);改面板、重启、目检前先读。`.dsh/skills`、`.claude/skills` 是指向 `.agents/skills` 的软链,`CLAUDE.md` 软链到 `AGENTS.md` |

## 改动的标准闭环

```
改代码 → 【bump package.json patch 版本】→ pnpm test(含面板构建)→ coopanion-plugin-dev 的重启阶段 → 同一 skill 的目检阶段
```

**版本必须 bump**:面板产物按 `/assets/extensions/<包>/<版本>/webui.js` 以 `Cache-Control: immutable` 提供——同版本内的改动,重启进程、换源都到不了浏览器。

## 常见变更的触点清单

### 新增一个配置项(触点最多,缺一不可)

1. `config.ts`:接口字段 + `RSS_DEFAULTS` + schema 属性 + `rssConfigGroups` 对应分组
2. `config-save.ts`:加入 `RSS_CONFIG_KEYS` 白名单;数值项加 `NUMBER_RANGES`
3. `strings.ts`:title/description,**zh 与 en 都要加**(结构对称)
4. `webui/client.ts`:`mountSettings`/`mountNotify` 的 fields 加一行
5. 影响运行时预算的键(如清理上限):`world.ts` 的 limits 活对象在 `config.save` 分支同步
6. 测试计数:`world.test` 的 config.get 键数、`config-save.test` 的白名单数

### 新增一个工具

`RSS_TOOL_DECLS`(声明)→ `world.ts` 的 `tools()` 加 handler → `RSS_SUMMARIES` 一句话 → `pnpm describe:local` 重新生成 `describe.json`(一致性测试自动守护)。

### 改面板 UI

遵循本仓库 skill **coopanion-plugin-dev**(`.agents/skills/coopanion-plugin-dev/`;其 `references/panel-ui-spec.md` 与 `references/ui-components.md`:组件行为、布局硬规则、对齐与缓存);目检走该 skill 的「阶段 F:受控浏览器目检」;生效走「阶段 E:重启 Coopanion」。

## 已踩过的坑(别再踩)

- **ESM**:禁止 `require`;import 带 `.ts` 扩展名。
- **describe.json** 由代码生成,手工改无效;改了工具/事件/ENV_PROMPT 必须重跑 `describe:local`。
- **测试不碰真实网络**:fetch 全部注入(`makeWorld`/`makeEnv`);真机用例走本地测试服务器且默认 skip。
- **bash 里 `node -e` 写含反引号的模板字符串会坏文件**(bash 先展开)——改 TypeScript 一律用结构化编辑,不用内联脚本。内联 `replace` 不匹配时**静默不报错**:0.1.18 曾因此发了一个未改动的包(版本照升、代码没变,排查三轮才发现)。改完必须 grep 验证标记字符串确实落盘,再构建。
- **含中文的 .ps1 必须 UTF-8 带 BOM**(PowerShell 5.1 按 GBK 解析无 BOM 文件)。
- **Git Bash 调 Windows 工具用双斜杠**(`taskkill //IM`),且别把这类路径放在行尾(尾反斜杠转义引号)。
- **pnpm 需要 node 在 PATH 里**,直接给 node.exe 全路径跑 pnpm.mjs 会因子进程找不到 node 失败。
- **两份 tsconfig 都要过**:面板改动只挂 web 侧错误时容易漏看。
- vitest 输出中文可能乱码(GBK 控制台),看断言以英文部分为准。

## 边界与红线

- 测试永不访问真实网络;外部行为只通过注入的 `fetchImpl` 模拟。
- 不引入遥测;网络面仅限用户配置的源地址 + `rss_read(full)` 的文章页;私网/本机地址默认允许(无开关)。
- 令牌/密钥:本扩展无;若未来需要,走 `ctx.secret()`,不进 config.json、不进日志。
- 发布由用户决定;发布前需在 Cortico 检出根跑 `describe:extension` + `check:extension`。

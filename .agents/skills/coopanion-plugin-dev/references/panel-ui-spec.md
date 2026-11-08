# Coopanion 扩展面板 UI 规范

> 本文件是 `coopanion-plugin-dev` skill 的参考件（原 `coopanion-panel-ui` skill 的正文）。写或改面板代码前先读它；组件级细节（CSS 行为、API 形状、代码片段）见同目录 `ui-components.md`。
> 规则全部来自真实用户反馈，每条后面都踩过坑。规则与具体业务无关：举例中的"筛选""概览"指任意面板里的同类元素。

## 0. 工作闭环（每次 UI 迭代都走完）

```
「目检」阶段发现问题（主 SKILL.md 阶段 F）
  → 改 src/webui/client.ts（遵循本规范）
  → 【必须】bump package.json patch 版本（immutable 缓存按版本 URL 钉死内容，同版本改动不生效！）
  → pnpm test（先 esbuild 面板，再 vitest）
  → 「重启」阶段重启 Coopanion（主 SKILL.md 阶段 E）
  → 回「目检」确认
```

## 1. 页面结构：面板即标签

- `webUi().panels[]` 的每个 panel 就是 World 页的一个**标签**；标题写主题，描述写一句话用途。
- **不声明 `config` 组** → 内建「配置」标签自动消失；配置做成自定义表单标签，保存走 `invoke('config.save', [patch])`（见 §4）。
- `promptDocs` 的 `title` 直接成为标签名——`role: envPrompt` 的文档标签就叫「环境提示词」，不要写扩展名。
- 标签内**不要再放与标签同名的页首简介**；卡片自带标题与说明，页首信息重复且占高度。

## 2. 布局硬规则（踩坑换来的）

1. **概览读数用独立小卡片，一卡一类；窄而高，不要拉满整行**——限宽（如 `flex: 0 0 230px`）+ 上下加大内边距（16px 上下）。主题里的 sheet 只有上边框（没有盒子感），必须内联补：`border: 1px solid var(--border); border-radius: 10px; background: var(--sheet); margin-top: 0`，卡片放进 `display:flex; gap:16px` 的行容器。
2. **操作按钮放在它作用的表格上方**，主操作用 `variant: 'primary'`——plain 按钮在暗色主题下几乎看不出是按钮。
3. **筛选与操作分离**：筛选类控件（segmented 等）靠左，动作按钮靠右，中间插 `ctx.ui.h('div', 'grow')` 占位——否则用户会把它们读成一排选项卡。
4. **表格必须对齐**：长列表加 `maxHeight`（表头置顶 + 内部滚动），并用固定列宽布局（colgroup + `table-layout: fixed`，例：主内容列弹性最大、徽标列窄、操作列中等；按内容定比例）。auto 布局在窄窗口会被宽内容列撑出视觉错位。长 URL/无空格串的格子加 `word-break: break-all`。
5. **列内对齐语义化**：表头与内容同规则——文本列左对齐；徽标/计数/状态列**水平居中**（表头一起居中）；操作列左对齐。实现：表头 `th` 与行内 `td` 各自设 `textAlign`，不要只对内容或只对表头。
   按钮列的特例：按钮自带水平内边距（`.btn.sm` 约 11px），按钮**文字**会比表头**文字**右移一截，看起来像"内容左边有边距"。修法：把按钮行 `margin-left` 拉回一个按钮内边距，让按钮文字对齐表头文字、按钮盒子齐平列边界。
   **垂直方向**：宿主表格 td 默认 `vertical-align: top`——多行内容的行里，单行元素（徽标、按钮、pill）会顶到上沿。**所有列统一设 `verticalAlign: 'middle'`**（含标题/操作这类长内容列）；行内嵌的 rowbar 要把自身 `margin-bottom` 清零，否则 margin 会把居中重心顶歪。长内容列（名称、标题、操作）水平保持左对齐，徽标/状态列水平居中。
   **flex 子项上 vertical-align 无效**：`label.check` 是 `inline-flex`，勾选框旁的提示标记是 flex 子项——调 `verticalAlign`（-2/-4/-10px）全部静默无效，垂直微调只能用 `transform: translateY(1px)`；圆形标记比文字高，缩小到 13px 再下沉才与文字重心平齐。改完用 computed transform + 与文字节点的中心差值量化验证，不要目测。
6. **状态短文案原则**：表格/列表里的状态 pill 只给短标签（`异常 ×N`、`正常`、`已暂停`），完整错误放悬停 title 与详情弹框；同一信息不要在两行重复展示。
7. **时间语义**："下次检查"这类未来时刻显示具体 HH:MM，相对时间（"刚刚"）只用于过去时刻。

## 3. 弹框（抽屉）布局

- 用 `ctx.ui.drawer(title, content)`：自带遮罩/Esc/关闭按钮；操作期间用 `ctx.ui.disable(...)` 临时禁用按钮，结束 dispose 恢复（不要在打开时就禁用）。
- **短字段两两并排**（名称/策略、间隔/备注这类），全宽只留给地址类长输入——弹框高度能减半。行容器：rowbar + 每格 `flex:1` 或 `flex: 0 0 <宽度>`。
- **分组用 `.sectionhead` 小节标题**（带分割线）；分组要承载语义，不要为了分组而分组。
- **布尔项用 `ctx.ui.checkbox(label)`**（框与标签内联的设计系统样式），下面配 `.sectiondesc` 说明小字；裸 `<input type=checkbox>` 又小又秃。
- 只读状态块用 `ctx.ui.kv`；与编辑表单之间用 sectionhead 分隔。

## 4. 配置保存通道（dsh-bridge 模式）

- 面板表单不接框架配置组；`invoke('config.get')` 预填 → 提交 `invoke('config.save', [patch])`。
- 服务端必须有**纯函数校验模块**：键白名单（拒绝框架保留键）、数值钳制、格式校验、**整单拒绝**；通过后写活配置（`cfg` 逐字段赋值）+ `ctx.persist(patch)` 落 config.json。
- 返回 `{ ok, restartRequired, applied }`；只有参与构造的键才标 `restartRequired`，面板据此提示重启。
- 配置项语义要单一：一项行为只在一个层面配置（全局默认值 vs 单条覆盖要写清），删掉失去职责的死旋钮。

## 5. 交付检查

- `describe.json` 含 promptDoc 标题——改了 `webUi().promptDocs` 的 title 后重跑 `describe:local`（或 `describe:extension`）。
- `tests/webui.test.ts`：dist 产物存在、ESM、panels 键与声明一致；manifest 版本号与 CHANGELOG 分节同步。
- 双 tsconfig typecheck（`tsc --noEmit && tsc -p tsconfig.web.json`）；面板代码只 `import type` cortico 模块、只经 `ctx.invoke` 通信、不碰 `document.body`。

## 6. 中文文案标点规范

写 zh 文案时**直接用全角标点**，不要写完再补：

- **紧贴汉字的 `, ; ? ! :` 一律全角**（，；？！：）；半角仅用于 ASCII 语境（代码、URL、`09:00` 时间、UA 字符串）。
- 全角 `？` 后**不加空格**（全角字符自带间隙）。
- 三处高频翻车点：①工具回执/确认弹框的模板串；②`strings.ts` 的 description；③概览卡片与表格的组合文案——写完扫一眼。
- 已有文案出现混用时，用本 skill 自带脚本全量清扫：

```bash
node .agents/skills/coopanion-plugin-dev/scripts/normalize-punct.mjs src/strings.ts src/world.ts   # 预览
node .agents/skills/coopanion-plugin-dev/scripts/normalize-punct.mjs src/strings.ts src/world.ts --apply  # 落盘
```

脚本只替换紧贴汉字（或全角括号/数字）的半角标点，ASCII 语境不受影响；预览确认后 `--apply` 落盘，再跑 typecheck + test。

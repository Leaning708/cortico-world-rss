# Cortico WebUI 组件速查(host 设计系统实测)

> 本文件是 `coopanion-plugin-dev` skill 的参考件（原 `coopanion-panel-ui` skill 的 `references/components.md`）。来源:`cortico/src/web/client/ui/*` 与 `public/styles.css` 的实际行为,配 `ctx.ui.*` 使用。布局硬规则见同目录 `panel-ui-spec.md`。

## 容器与行

| 组件 | 行为 | 用途 |
|---|---|---|
| `sheet({title, desc})` | 卡片;**只有上边框**,无底色边框盒 | 页面主要分区。需要盒子感时内联补 border/background/radius |
| `foldSheet(id, opts)` | 可折叠卡片,折叠态记在 memo | 次要/长内容 |
| `rowbar()` | flex 行,gap 12px,左对齐,`margin-bottom:10px` | 内容行、按钮行、表单并排字段 |
| `actions()` | `rowbar actionbar`:**右对齐 + margin-top:24px + 上分割线** | 只做卡片底部确认行;当内容行用会出现"莫名其妙的分割线+大空隙" |
| `sectionhead` | h4 小节标题 + 上分割线,`margin:28px 0 14px`;紧跟 sh-desc 时收缩 | 卡内分组;`sectiondesc` 是配套灰说明字 |
| `statgrid` / `stat({k,v,accent,unit})` | 读数网格;`.stat .v` 大数字,accent 强调色 | 概览数字。独立卡片里可只渲染 `.stat > .v` |
| `kv(rows)` | 无表头键值表(k 灰窄,v 等宽) | 详情只读块 |
| `msgline(text?, bad?)` | 一行结果消息,`:empty` 自动隐藏,`.bad` 警示色 | 每个面板的操作反馈出口 |
| `h('div', 'grow')` | `flex:1` 占位(样式表已定义 `.grow`) | 行内左右分组隔离 |

## 控件

| 组件 | 行为与坑 |
|---|---|
| `button(label, {variant, size, onClick})` | **API 只开放三种 variant:`'plain' \| 'primary' \| 'danger'`**(`size: 'sm' \| 'md'`)。plain 透明底细边框、hover 才变亮(**暗色主题下近乎纯文字,重要操作别用**);primary 强调色实心;danger 红字红边(破坏性)。CSS 里虽有 `.btn.warn` 规则但 `button()` 不生成该类,扩展用不了 |
| `input({type, placeholder, cls})` / `select` / `textarea({rows})` | `.field` 样式;select 默认宽随内容,并排时给 field 定宽 |
| `checkbox(label)` | 返回 `{el, input, checked, setChecked}`;label.check 内联样式,**比裸 checkbox 好一个档次**;`setChecked` 不触发 onChange |
| 提示标记(勾选框旁的 ⓘ) | 自制小圆 `!` + `title`,宿主全局 `mountHoverHints` 自动转成样式化气泡。**坑:`label.check` 是 inline-flex,标记是 flex 子项,`vertical-align` 无效**——垂直微调用 `transform: translateY(1px)`;标记 13px 与文字视觉高度一致。片段见下 |
| `copyButton(text, opts?)` | 复制按钮,点击带反馈 |
| `field(label, control)` | label 包控件(label 在上);作为 flex 子项时给 `flex:1` 或定宽。**必填标记约定:label 以 `*` 结尾时自动渲染红色 `.required-mark`**,星号从标题文本剥掉 |
| `segmented(items, {value, size, onSelect})` | 分段单选;外观像选项卡——**别和动作按钮排在同一段** |
| `pill(text, tone)` | `on/off/plain` 三色;长文本会撑爆,只放短标签 |
| `chip(text, tone)` | `plain/warn/accent`;数字徽标用 |
| `table({head, maxHeight})` | 返回 `{el, body, addRow, clear}`;cell 可放节点/`{el, cls}`;maxHeight 才有粘性表头;**加 colgroup + table-layout:fixed 保证表头对齐** |
| `confirm({title, body, danger})` | 模态确认,返回 boolean;删除类必加 |
| `drawer(title, body)` | 侧抽屉,Esc/遮罩可关;`dispose()` 编程关闭 |
| `disable(...els)` | 临时禁用,dispose 恢复原值;**不要打开时永久禁用** |
| `toast` / `busy` | 自动消失的提示 / 整页阻塞,按需用 |

## 对齐与列宽(table)

```ts
// 固定列宽:表头与任何行严格对齐;比例按内容定
const el = table.el.querySelector('table');
el.style.tableLayout = 'fixed';
const cg = document.createElement('colgroup');
for (const w of ['40%', '18%', '12%', '30%']) {
  const col = document.createElement('col'); col.style.width = w; cg.appendChild(col);
}
el.appendChild(cg);

// 列内对齐语义化:表头与内容同规则
const ths = table.el.querySelectorAll('thead th');
ths[1].style.textAlign = 'center';   // 徽标/计数/状态列:表头居中
// addRow 返回行元素,内容单元格同步居中
const tr = table.addRow([cell0, cell1, cell2]);
(tr.children[1] as HTMLElement).style.textAlign = 'center';
```

## 面板契约要点

- `src/webui/client.ts` 默认导出 `{ panels: { <panelId>: { mount(ctx) } } }`;esbuild 打成 `dist/webui.js` 随包提交(`pnpm test` 先构建)。
- 浏览器侧对 cortico 只能 `import type`;与宿主的一切通信走 `ctx.invoke(method, args)`。
- 面板只是标签:invoke 按 method 分发即可(不必按 panel 区分);未知 method 抛错。
- `tsconfig.web.json` 才带 DOM;Node 侧 tsconfig 排除 `src/webui`。

## 常用代码片段(实测)

```ts
// 筛选左、操作右
const bar = ctx.ui.rowbar();
bar.append(filterSeg.el, ctx.ui.h('div', 'grow'), actionBtnA, actionBtnB);

// 概览小卡片:窄而高,盒子感
const row = ctx.ui.h('div', null);
row.style.display = 'flex'; row.style.gap = '16px';
const card = ctx.ui.sheet({ title });
card.el.style.flex = '0 0 230px';          // 限宽,不拉满整行
card.el.style.marginTop = '0';
card.el.style.border = '1px solid var(--border)';
card.el.style.borderRadius = '10px';
card.el.style.background = 'var(--sheet)';
card.el.style.padding = '16px 18px 14px';  // 上下留白撑高度

// 操作锁:期间禁用按钮,结束恢复
const locked = async (task: () => Promise<void>): Promise<void> => {
  const lock = ctx.ui.disable(btnA, btnB);
  try { await task(); } catch (e) { show(`${t.failed}: ${errorText(e)}`, true); }
  finally { lock.dispose(); }
};

// 勾选框旁的"!"提示标记:text 进 title,宿主 hover-hint 转成气泡
// 注意 label.check 是 inline-flex——flex 子项上 vertical-align 无效,用 transform
function hintMark(ctx: WebUiPanelContext, text: string): HTMLElement {
  const mark = ctx.ui.h('span', null, '!');
  mark.title = text;
  mark.ariaLabel = text;
  mark.style.display = 'inline-grid';
  mark.style.placeItems = 'center';
  mark.style.flex = 'none';
  mark.style.width = '13px';
  mark.style.height = '13px';
  mark.style.marginLeft = '2px';
  mark.style.borderRadius = '50%';
  mark.style.border = '1px solid var(--line-strong)';
  mark.style.color = 'var(--ink-dim)';
  mark.style.font = '600 9px/1 var(--sans)';
  mark.style.cursor = 'help';
  mark.style.transform = 'translateY(1px)'; // 圆比文字高,光学下沉
  return mark;
}
// 用法:check.el.appendChild(hintMark(ctx, hint)); 勾选项与上字段间距:check.el.style.marginTop = '14px'
```

## 配置保存(纯校验模块模式)

独立纯函数模块:`KEYS` 白名单(as const satisfies,排除框架保留键)+ 数值钳制(min/max/step)+ 格式校验;`sanitize(input, current)` 返回 `{patch, restartRequired}`,非法**整单抛错**。浏览器侧(Node 侧同用)可拿同一张表做预校验——单测直接覆盖校验表。

## 版本与缓存

- 面板产物 URL:`/assets/extensions/<包名>/<版本>/webui.js`,响应头 `Cache-Control: public, max-age=31536000, immutable`。
- **同一版本号内的任何改动都到不了浏览器**(重启进程、换源也没用)。每次面板迭代:bump patch 版本 → CHANGELOG 分节 → 构建 → 重启。
- 目检与排查见主 `SKILL.md` 的「阶段 F：受控浏览器目检 WebUI」（受控浏览器 + immutable 缓存排查步骤）。

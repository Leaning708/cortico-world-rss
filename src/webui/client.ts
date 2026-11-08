/**
 * RSS 订阅面板(浏览器端)。五个面板 = World 页的五个标签:
 *   订阅源 / 收件箱 / 通知 / 设置 / OPML。
 * 只通过 ctx.invoke 与宿主数据面通信;配置表单保存走 config.save(服务端白名单校验 + persist)。
 * 排版全部使用宿主设计系统:sheet / table / statgrid / rowbar / field。
 */
import type {
  WebUiClientBundle,
  WebUiPanel,
  WebUiPanelContext,
} from 'cortico/web/shared/client-panel.ts';
import { text } from '../strings.ts';

interface Overview {
  feeds: number;
  unread: number;
  fetched24h: number;
  failing: Array<{ id: string; title: string; error: string | null }>;
  defaultUserAgent: string;
  limits: { retentionDays: number; maxItemsTotal: number; maxItemsPerFeed: number };
}

interface FeedRow {
  id: string;
  url: string;
  title: string;
  notify: 'notify' | 'mute';
  intervalMinutes: number;
  paused: boolean;
  lastError: string | null;
  consecutiveErrors: number;
  lastOkAt: string | null;
  unread: number;
  userAgent: string;
  fullText?: boolean;
  createdAt?: string;
  nextPollAt?: string | null;
}

interface ItemRow {
  key: string;
  feedId: string;
  feedTitle: string;
  title: string;
  url: string;
  publishedAt: string;
  read: boolean;
  starred: boolean;
}

interface TestResult {
  ok: true;
  feedUrl: string;
  title: string;
  discovered: boolean;
  sample: string[];
  total: number;
}

interface RefreshResult {
  results: Array<{ feedTitle: string; ok: boolean; newCount: number; notModified: boolean; error: string | null }>;
}

/** config.get 回来的全部旋钮当前值。 */
type ConfigValues = Record<string, string | number | boolean>;

/**
 * 勾选框旁的"!"提示标记:text 挂在 title 上,宿主全局的 mountHoverHints 会把它
 * 转成样式化悬浮气泡(hover 450ms 后出现在标记下方)。
 * 注意:label.check 是 inline-flex,标记是 flex 子项——vertical-align 对它无效,
 * 垂直微调只能用 transform。
 */
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
  // 圆比文字高,居中对齐后不再额外下沉,避免小字号下显得偏低。
  mark.style.transform = 'translateY(0)';
  return mark;
}

/**
 * 字段标签(小号灰字)旁的提示标记:字段标签不是 flex 容器,圆圈在行内按基线对齐会偏下,
 * 改用 vertical-align:middle 居中,并比勾选旁的标记多留一点间距。
 */
function fieldHintMark(ctx: WebUiPanelContext, text: string): HTMLElement {
  const mark = hintMark(ctx, text);
  mark.style.verticalAlign = 'middle';
  mark.style.marginLeft = '5px';
  // 小号标签的盒中心低于文字视觉重心,再上提 1px 才与字形平齐。
  mark.style.transform = 'translateY(-1px)';
  return mark;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 存储值 → `<input type="time">` 能接受的 `HH:MM`。
 * 小时补两位:旧版文本输入允许 `9:00`(服务端校验也放行),而 time 控件只认 `09:00`,
 * 直接赋值会被浏览器静默拒绝、回填成空。非法值给空串。
 */
function timeValue(raw: unknown): string {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(typeof raw === 'string' ? raw : '');
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : '';
}

function timeShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}

/** 收件箱面板(mount 收集器,便于测试与复用)。 */
function mountInbox(ctx: WebUiPanelContext): void {
  const t = text(ctx.language);
  const message = ctx.ui.msgline();
  const show = (body: string, bad = false): void => {
    message.textContent = body;
    message.classList.toggle('bad', bad);
  };
  const sheet = ctx.ui.sheet({ title: t.inboxSheetTitle });
  // 清理规则说明:数值随配置实时刷新(refresh 里写入)。
  const rulesLine = ctx.ui.h('div', 'sectiondesc', '');
  sheet.body.appendChild(rulesLine);
  const checkboxes = new Map<string, HTMLInputElement>();
  const checkedKeys = (): string[] =>
    [...checkboxes.entries()].filter(([, box]) => box.checked).map(([key]) => key);

  // 分页:每页固定条数,范围/源切换时回到第一页。
  const PAGE_SIZE = 10;
  let page = 0;
  let lastTotal = 0;

  const bar = ctx.ui.rowbar();
  const scopeSeg = ctx.ui.segmented(
    [
      { value: 'unread', label: '未读' },
      { value: 'all', label: '全部' },
      { value: 'starred', label: '星标' },
    ],
    { value: 'unread', size: 'sm', onSelect: () => { page = 0; void refresh(); } },
  );
  // 源过滤:选项随 feeds.list 刷新,保留当前选择。
  const feedSelect = ctx.ui.select();
  feedSelect.appendChild(new Option(t.allFeeds, ''));
  feedSelect.addEventListener('change', () => { page = 0; void refresh(); });
  const markReadBtn = ctx.ui.button(t.markRead, { size: 'sm', onClick: () => void locked(() => mark('read')) });
  const starBtn = ctx.ui.button(t.star, { size: 'sm', onClick: () => void locked(() => mark('starred')) });
  const markAllBtn = ctx.ui.button(t.markAllRead, {
    size: 'sm',
    variant: 'danger',
    onClick: () => void locked(async () => {
      const confirmed = await ctx.ui.confirm({ title: t.markAllRead, body: t.markAllConfirm, danger: true });
      if (!confirmed) return;
      const result = await ctx.invoke<{ changed: number }>('items.mark', [{ all: true, status: 'read' }]);
      show(t.marked(result.changed));
      page = 0;
      await refresh();
    }),
  });
  // 清空条目:按当前范围 + 源过滤清空,确认弹框列出将清空的内容与条数。
  const clearBtn = ctx.ui.button(t.clearItems, {
    size: 'sm',
    variant: 'danger',
    onClick: () => void locked(async () => {
      const checked = checkedKeys();
      // 有勾选:只删勾选的条目(明确意图,星标也删);无勾选:按范围 + 源清空。
      if (checked.length > 0) {
        const confirmed = await ctx.ui.confirm({
          title: t.deleteSelected,
          body: t.deleteSelectedConfirm(checked.length),
          danger: true,
        });
        if (!confirmed) return;
        const result = await ctx.invoke<{ cleared: number }>('items.clear', [{ ids: checked }]);
        show(t.clearedItems(result.cleared));
        await refresh();
        return;
      }
      const scope = scopeSeg.value || 'unread';
      const feedId = feedSelect.value || undefined;
      const probe = await ctx.invoke<{ total: number }>('items.list', [{
        scope,
        ...(feedId ? { feedId } : {}),
        limit: 1,
      }]);
      if (probe.total === 0) { show(t.emptyInbox, true); return; }
      const scopeName = { unread: '未读条目', all: '全部条目', starred: '星标条目' }[scope] ?? '条目';
      const feedTitle = feedId ? feedSelect.selectedOptions[0]?.textContent ?? '所选源' : null;
      const what = `${feedTitle ? `「${feedTitle}」的` : '全部源的'}${scopeName}`;
      const confirmed = await ctx.ui.confirm({
        title: t.clearItems,
        body: t.clearItemsConfirm(what, probe.total, scope !== 'starred'),
        danger: true,
      });
      if (!confirmed) return;
      const result = await ctx.invoke<{ cleared: number }>('items.clear', [{
        scope,
        ...(feedId ? { feedId } : {}),
      }]);
      show(t.clearedItems(result.cleared));
      page = 0;
      await refresh();
    }),
  });
  // 左边是范围与源筛选,右边是批量操作:加 grow 占位隔开,避免被读成一排选项卡。
  bar.append(scopeSeg.el, feedSelect, ctx.ui.h('div', 'grow'), markReadBtn, starBtn, markAllBtn, clearBtn);
  sheet.body.appendChild(bar);
  const table = ctx.ui.table({ head: ['', t.colTitle, t.colFeed, t.colTime] });
  // 勾选变化时刷新「清空条目/删除已选」按钮文字(勾选框在 renderItems 里逐个挂 change 监听)。
  table.el.addEventListener('change', updateClearLabel);
  const itemsTableEl = table.el.querySelector('table');
  if (itemsTableEl) {
    itemsTableEl.style.tableLayout = 'fixed';
    const itemsCols = document.createElement('colgroup');
    for (const width of ['36px', '56%', '24%', '20%']) {
      const col = document.createElement('col');
      col.style.width = width;
      itemsCols.appendChild(col);
    }
    itemsTableEl.appendChild(itemsCols);
  }
  sheet.body.appendChild(table.el);

  // 分页条:上一页 / 页码 / 下一页,置于表格下方。
  const pager = ctx.ui.rowbar();
  const prevBtn = ctx.ui.button(t.prevPage, {
    size: 'sm',
    onClick: () => { if (page > 0) { page -= 1; void refresh(); } },
  });
  const nextBtn = ctx.ui.button(t.nextPage, {
    size: 'sm',
    onClick: () => { if ((page + 1) * PAGE_SIZE < lastTotal) { page += 1; void refresh(); } },
  });
  const pageLabel = ctx.ui.h('div', null, '');
  pageLabel.style.opacity = '0.7';
  pager.append(prevBtn, pageLabel, ctx.ui.h('div', 'grow'), nextBtn);
  sheet.body.appendChild(pager);

  ctx.root.appendChild(sheet.el);
  ctx.root.appendChild(message);

  async function mark(status: 'read' | 'starred'): Promise<void> {
    const keys = checkedKeys();
    if (keys.length === 0) { show(t.noneSelected, true); return; }
    const result = await ctx.invoke<{ changed: number }>('items.mark', [{ ids: keys, status }]);
    show(t.marked(result.changed));
    await refresh();
  }

  /** 勾选变化时切换按钮文字:有勾选 = 「删除已选」,无勾选 = 「清空条目」。 */
  function updateClearLabel(): void {
    clearBtn.textContent = checkedKeys().length > 0 ? t.deleteSelected : t.clearItems;
  }

  function renderItems(payload: { total: number; items: ItemRow[] }): void {
    lastTotal = payload.total;
    checkboxes.clear();
    const pages = Math.max(1, Math.ceil(payload.total / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    // 单页(≤每页条数):整表直出、隐藏分页条;多页:按页切片。
    const paginate = pages > 1;
    pager.style.display = paginate ? '' : 'none';
    pageLabel.textContent = t.pageOf(page + 1, pages, payload.total);
    prevBtn.disabled = page <= 0;
    nextBtn.disabled = page >= pages - 1;

    table.clear();
    if (payload.items.length === 0) {
      // 空态:保留约 10 行的高度,提示文字居中。
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.style.height = '400px';
      td.style.textAlign = 'center';
      td.style.verticalAlign = 'middle';
      td.style.color = 'var(--muted-foreground)';
      td.textContent = t.emptyInbox;
      tr.appendChild(td);
      table.body.appendChild(tr);
      return;
    }
    const visible = paginate
      ? payload.items.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
      : payload.items;
    for (const item of visible) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = item.key;
      checkboxes.set(item.key, box);
      const link = document.createElement('a');
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = `${item.starred ? '★ ' : ''}${item.title || item.url}`;
      if (item.read) link.style.opacity = '0.55';
      const tr = table.addRow([{ el: box }, { el: link }, item.feedTitle, timeShort(item.publishedAt)]);
      for (const cell of tr.children) (cell as HTMLElement).style.verticalAlign = 'middle';
      box.addEventListener('change', updateClearLabel);
    }
    updateClearLabel();
  }

  const refresh = async (): Promise<void> => {
    try {
      const overview = await ctx.invoke<Overview>('overview');
      rulesLine.textContent = t.inboxDesc(
        overview.limits.retentionDays,
        overview.limits.maxItemsTotal,
        overview.limits.maxItemsPerFeed,
      );
      // 源过滤选项:随 feeds.list 刷新,保留当前选择。
      const feeds = await ctx.invoke<FeedRow[]>('feeds.list');
      const selected = feedSelect.value;
      feedSelect.replaceChildren(new Option(t.allFeeds, ''));
      for (const feed of feeds) feedSelect.appendChild(new Option(feed.title, feed.id));
      feedSelect.value = selected;
      if (feedSelect.value !== selected) feedSelect.value = '';

      // 整库取回(≤2000 条),分页与"≤10 页整表直出"都在客户端切片。
      renderItems(await ctx.invoke<{ total: number; items: ItemRow[] }>('items.list', [{
        scope: scopeSeg.value || 'unread',
        ...(feedSelect.value ? { feedId: feedSelect.value } : {}),
        limit: 5000,
        offset: 0,
      }]));
    } catch (error) {
      show(`${t.loadError}: ${errorText(error)}`, true);
    }
  };

  const locked = async (task: () => Promise<void>): Promise<void> => {
    const lock = ctx.ui.disable(markReadBtn, starBtn);
    try {
      await task();
    } catch (error) {
      show(`${t.failed}: ${errorText(error)}`, true);
    } finally {
      lock.dispose();
    }
  };

  void refresh();
}

/** 订阅源面板:概览读数(添加/拉取全部)+ 源表;添加与编辑都在抽屉弹框里完成。 */
function mountFeeds(ctx: WebUiPanelContext): void {
  const t = text(ctx.language);
  const message = ctx.ui.msgline();
  const show = (body: string, bad = false): void => {
    message.textContent = body;
    message.classList.toggle('bad', bad);
  };

  // ── 概览:每类一张小卡片 ────────────────────────────────────────────
  const cardsRow = ctx.ui.h('div', null);
  cardsRow.style.display = 'flex';
  cardsRow.style.gap = '16px';
  cardsRow.style.alignItems = 'stretch';
  const makeCard = (title: string): { value: HTMLElement; el: HTMLElement } => {
    const card = ctx.ui.sheet({ title });
    // 窄而高:限宽不拉满整行,标题与数字之间留出呼吸感。
    card.el.style.flex = '0 0 180px';
    card.el.style.marginTop = '0';
    // 主题里的 sheet 只有上边框;概览小卡片需要明确的盒子感。
    card.el.style.border = '1px solid var(--border)';
    card.el.style.background = 'var(--sheet)';
    card.el.style.borderRadius = '10px';
    card.el.style.padding = '18px 18px 16px';
    card.body.style.marginTop = '14px';
    const value = ctx.ui.h('div', 'v', '0');
    const stat = ctx.ui.h('div', 'stat');
    stat.appendChild(value);
    stat.style.marginTop = '4px';
    card.body.appendChild(stat);
    cardsRow.appendChild(card.el);
    return { value, el: card.el };
  };
  const cardFeeds = makeCard(t.statFeeds);
  const cardUnread = makeCard(t.statUnread);
  const cardFresh = makeCard(t.statFresh);
  ctx.root.appendChild(cardsRow);

  // ── 订阅源:操作按钮在表格上方 ──────────────────────────────────────
  const feedsSheet = ctx.ui.sheet({ title: t.feedsSheetTitle, desc: t.feedsSheetDesc });
  const addOpenBtn = ctx.ui.button(t.addDialogTitle, { variant: 'primary', onClick: () => openAddDialog() });
  const pullAllBtn = ctx.ui.button(t.pullAll, {
    variant: 'primary',
    onClick: () => void locked(async () => {
      const result = await ctx.invoke<RefreshResult>('feeds.refresh', [{}]);
      const okCount = result.results.filter((r) => r.ok).length;
      const failCount = result.results.filter((r) => !r.ok).length;
      const fresh = result.results.reduce((sum, r) => sum + (r.ok ? r.newCount : 0), 0);
      show(t.pullResult(okCount, fresh, failCount));
      await refresh();
    }),
  });
  const feedsBar = ctx.ui.rowbar();
  feedsBar.append(addOpenBtn, pullAllBtn);
  feedsSheet.body.appendChild(feedsBar);

  const feedsTable = ctx.ui.table({ head: [t.colTitle, t.colStatus, t.colUnread, t.colActions] });
  // 固定列宽布局:表头与内容在任何窗口宽度下都对齐,窄窗时内容在列内换行而不是挤歪列。
  const feedsTableEl = feedsTable.el.querySelector('table');
  if (feedsTableEl) {
    feedsTableEl.style.tableLayout = 'fixed';
    const colgroup = document.createElement('colgroup');
    for (const width of ['42%', '16%', '10%', '32%']) {
      const col = document.createElement('col');
      col.style.width = width;
      colgroup.appendChild(col);
    }
    feedsTableEl.appendChild(colgroup);
    // 列内对齐语义化:状态/未读居中(表头与内容一致),操作列左对齐。
    const headCells = feedsTableEl.querySelectorAll('thead th');
    const statusTh = headCells[1] as HTMLElement | undefined;
    const unreadTh = headCells[2] as HTMLElement | undefined;
    if (statusTh) statusTh.style.textAlign = 'center';
    if (unreadTh) unreadTh.style.textAlign = 'center';
  }
  feedsSheet.body.appendChild(feedsTable.el);

  // 分页条:默认隐藏(≤5 页的列表直接整表直出)。
  const feedsPager = ctx.ui.rowbar();
  const feedsPrevBtn = ctx.ui.button(t.prevPage, {
    size: 'sm',
    onClick: () => { if (feedPage > 0) { feedPage -= 1; renderFeeds(allFeedRows); } },
  });
  const feedsNextBtn = ctx.ui.button(t.nextPage, {
    size: 'sm',
    onClick: () => {
      const pages = Math.max(1, Math.ceil(allFeedRows.length / FEEDS_PAGE_SIZE));
      if (feedPage < pages - 1) { feedPage += 1; renderFeeds(allFeedRows); }
    },
  });
  const feedPageLabel = ctx.ui.h('div', null, '');
  feedPageLabel.style.opacity = '0.7';
  feedsPager.append(feedsPrevBtn, feedPageLabel, ctx.ui.h('div', 'grow'), feedsNextBtn);
  feedsPager.style.display = 'none';
  feedsSheet.body.appendChild(feedsPager);
  ctx.root.appendChild(feedsSheet.el);
  ctx.root.appendChild(message);

  /** overview 返回的默认 UA(含插件版本号),用作单源 UA 输入框的占位提示。 */
  let defaultUserAgent = '';

  // ── 表单字段装配(添加与详情共用) ─────────────────────────────────
  interface FormControls {
    title: HTMLInputElement;
    notify: HTMLSelectElement;
    interval: HTMLInputElement;
    userAgent: HTMLInputElement;
    fullText: HTMLInputElement;
  }

  /** 弹框表单的一行:cells 依次排开;固定宽度的格子用 width,弹性的用 grow。 */
  function formRow(cells: ReadonlyArray<{ el: HTMLElement; grow?: boolean; width?: string }>): HTMLElement {
    const row = ctx.ui.rowbar();
    for (const cell of cells) {
      cell.el.style.flex = cell.width ? `0 0 ${cell.width}` : '1';
      cell.el.style.minWidth = cell.width ? '0' : '160px';
      row.appendChild(cell.el);
    }
    return row;
  }

  /** 弹框底部操作行:上分割线把按钮与配置项分开。 */
  function dialogActions(...controls: HTMLElement[]): HTMLElement {
    const bar = ctx.ui.rowbar();
    bar.style.borderTop = '1px solid var(--line)';
    bar.style.paddingTop = '14px';
    bar.style.marginTop = '6px';
    bar.append(...controls);
    return bar;
  }

  function buildFormFields(body: HTMLElement, feed?: FeedRow): FormControls {
    const title = ctx.ui.input({ placeholder: t.fieldTitlePlaceholder });
    title.value = feed?.title ?? '';
    const notify = ctx.ui.select();
    for (const [value, label] of [['notify', t.notifyBadge.notify], ['mute', t.notifyBadge.mute]] as const) {
      notify.appendChild(new Option(label, value));
    }
    notify.value = feed?.notify ?? 'notify';
    const interval = ctx.ui.input({ type: 'number', placeholder: t.fieldIntervalPlaceholder });
    interval.min = '1';
    interval.value = feed && feed.intervalMinutes > 0 ? String(feed.intervalMinutes) : '';
    const userAgent = ctx.ui.input({ placeholder: defaultUserAgent || 'Coopanion RSS Reader', cls: 'mono' });
    userAgent.value = feed?.userAgent ?? '';
    const fullText = ctx.ui.checkbox(t.fieldFullText);
    fullText.setChecked(feed ? feed.fullText !== false : true);

    // 名称独占一行。
    body.appendChild(formRow([
      { el: ctx.ui.field(t.fieldTitle, title), grow: true },
    ]));
    // 检查间隔 / 通知策略 同一行。
    body.appendChild(formRow([
      { el: ctx.ui.field(t.fieldInterval, interval), width: '190px' },
      { el: ctx.ui.field(t.fieldNotify, notify), width: '190px' },
    ]));
    // 允许抓取原文:在检查间隔下方单独一行、靠左。
    fullText.el.appendChild(hintMark(ctx, t.fieldFullTextHint));
    fullText.el.style.marginTop = '14px';
    const fetchRow = ctx.ui.h('div', null);
    fetchRow.appendChild(fullText.el);
    body.appendChild(fetchRow);
    // User-Agent 独占一行。
    body.appendChild(formRow([
      { el: ctx.ui.field(t.fieldUA, userAgent), grow: true },
    ]));
    return { title, notify, interval, userAgent, fullText: fullText.input };
  }

  /** 检查间隔留空 = 用全局默认;填了就必须 ≥1 分钟。 */
  function intervalValid(form: FormControls): boolean {
    const raw = form.interval.value.trim();
    return raw === '' || (Number.isFinite(Number(raw)) && Number(raw) >= 1);
  }

  function readForm(form: FormControls, url: string): Record<string, unknown> {
    return {
      url,
      title: form.title.value.trim() || undefined,
      notify: form.notify.value,
      intervalMinutes: form.interval.value.trim() ? Number(form.interval.value.trim()) : 0,
      userAgent: form.userAgent.value.trim(),
      fullText: form.fullText.checked,
    };
  }

  /** 添加订阅弹框:地址 + 全套按源配置。 */
  function openAddDialog(): void {
    const body = ctx.ui.h('div', null);
    const urlInput = ctx.ui.input({ placeholder: t.feedUrlPlaceholder, cls: 'mono' });
    // label 以 * 结尾:宿主 field() 自动渲染红色必填标记(required-mark)。
    body.appendChild(ctx.ui.field(`${t.feedUrlLabel} *`, urlInput));
    const form = buildFormFields(body);
    const testLine = ctx.ui.msgline();

    const testBtn = ctx.ui.button(t.dialogTest, {
      onClick: () => void dialogLocked(async () => {
        const url = urlInput.value.trim();
        if (!url) { dlgShow(t.needUrl, true); return; }
        const result = await ctx.invoke<TestResult>('feeds.test', [{ url }]);
        // 识别成功:名称留空时自动填充。
        if (!form.title.value.trim() && result.title) form.title.value = result.title;
        const lines = [
          `${t.testOkTitle} 「${result.title || result.feedUrl}」${result.discovered ? '(自动发现)' : ''} · ${t.testItems(result.total)}`,
          t.testSamples,
          ...result.sample.map((s) => `· ${s.slice(0, 60)}`),
        ];
        testLine.textContent = lines.join('\n');
      }),
    });
    const saveBtn = ctx.ui.button(t.dialogSave, {
      variant: 'primary',
      onClick: () => void dialogLocked(async () => {
        const url = urlInput.value.trim();
        if (!url) { dlgShow(t.needUrl, true); return; }
        if (!intervalValid(form)) { dlgShow(t.intervalMin, true); return; }
        const result = await ctx.invoke<{ id: string; title: string }>('feeds.add', [
          readForm(form, url),
        ]);
        // 先关弹框再提示:成功信息落在面板消息行,关闭后立即可见。
        closeDrawer();
        show(t.added(result.title, 1));
        await refresh();
      }),
    });
    body.appendChild(dialogActions(saveBtn, testBtn));
    testLine.style.whiteSpace = 'pre-line';
    body.appendChild(testLine);

    const { closeDrawer, dlgShow, dialogLocked } = openDrawer(t.addDialogTitle, body, [testBtn, saveBtn]);
    void closeDrawer;
  }

  /** 订阅详情弹框:状态只读块 + 同一套编辑字段。 */
  function openDetailDialog(feed: FeedRow): void {
    const body = ctx.ui.h('div', null);

    const statusRows = [
      // 状态只给短标签;完整错误在「最近错误」一行,不再重复展示。
      { k: t.detailStatus, v: feed.paused ? t.detailPaused : feed.consecutiveErrors > 0 ? t.errorShort(feed.consecutiveErrors) : t.lampPollOnline },
      { k: t.detailUrl, v: feed.url },
      { k: t.detailLastOk, v: feed.lastOkAt ? timeShort(feed.lastOkAt) : '—' },
      ...(feed.consecutiveErrors > 0 && feed.lastError ? [{ k: t.detailLastError, v: feed.lastError }] : []),
      { k: t.detailNextPoll, v: feed.paused || !feed.nextPollAt ? '—' : new Date(feed.nextPollAt).toTimeString().slice(0, 5) },
      { k: t.detailCreated, v: feed.createdAt ? timeShort(feed.createdAt) : '—' },
    ];
    body.appendChild(ctx.ui.kv(statusRows));
    body.appendChild(ctx.ui.h('div', 'sectionhead', t.sectionSettingsTitle));

    const form = buildFormFields(body, feed);
    const saveBtn = ctx.ui.button(t.dialogUpdate, {
      variant: 'primary',
      onClick: () => void dialogLocked(async () => {
        if (!intervalValid(form)) { dlgShow(t.intervalMin, true); return; }
        const values = readForm(form, feed.url);
        delete values.url;
        await ctx.invoke('feeds.update', [{ id: feed.id, patch: values }]);
        // 先关弹框再提示:成功信息落在面板消息行,关闭后立即可见。
        closeDrawer();
        show(t.savedFeed);
        await refresh();
      }),
    });
    const fetchBtn = ctx.ui.button(t.dialogFetch, {
      onClick: () => void dialogLocked(async () => {
        const result = await ctx.invoke<RefreshResult>('feeds.refresh', [{ id: feed.id }]);
        const one = result.results[0];
        // 弹框保持打开:拉取结果显示在弹框内部,不落到被遮罩挡住的面板消息。
        dlgShow(one ? t.pullOne(feed.title, one.newCount, one.notModified, one.error) : t.failed);
        await refresh();
      }),
    });
    body.appendChild(dialogActions(saveBtn, fetchBtn));

    const { closeDrawer, dlgShow, dialogLocked } = openDrawer(t.detailDialogTitle, body, [saveBtn, fetchBtn]);
    void closeDrawer;
  }

  /**
   * 抽屉壳:drawer 自带遮罩/Esc/关闭按钮。dialogLocked 在操作期间临时禁用按钮,
   * 结束后恢复;抽屉本体由 closeDrawer 或用户(Esc/遮罩/关闭钮)关闭。
   * 弹框自带一条内部消息行(dlgShow):错误与弹框内操作的结果显示在弹框里,
   * 不会落到被遮罩挡住的面板消息上;成功且关闭弹框后的提示才走面板级 show。
   */
  function openDrawer(title: string, content: HTMLElement, controls: readonly HTMLButtonElement[]): {
    closeDrawer(): void;
    dlgShow(body: string, bad?: boolean): void;
    dialogLocked(task: () => Promise<void>): Promise<void>;
  } {
    const drawer = ctx.ui.drawer(title, content);
    const dlgMessage = ctx.ui.msgline();
    content.appendChild(dlgMessage);
    const dlgShow = (body: string, bad = false): void => {
      dlgMessage.textContent = body;
      dlgMessage.classList.toggle('bad', bad);
    };
    return {
      closeDrawer: () => drawer.dispose(),
      dlgShow,
      dialogLocked: async (task: () => Promise<void>): Promise<void> => {
        const lock = ctx.ui.disable(...controls);
        try {
          await task();
        } catch (error) {
          dlgShow(`${t.failed}: ${errorText(error)}`, true);
        } finally {
          lock.dispose();
        }
      },
    };
  }

  // 订阅源分页:每页 5 条;超过 5 页才显示分页条,否则整表直出。
  const FEEDS_PAGE_SIZE = 5;
  let allFeedRows: FeedRow[] = [];
  let feedPage = 0;

  function renderFeeds(rows: FeedRow[]): void {
    allFeedRows = rows;
    const pages = Math.max(1, Math.ceil(rows.length / FEEDS_PAGE_SIZE));
    feedPage = Math.min(feedPage, pages - 1);
    // 每页固定 5 条:单页(≤5 条)时切片等于整表,分页条隐藏;多页时按页切片。
    const pageRows = rows.slice(feedPage * FEEDS_PAGE_SIZE, feedPage * FEEDS_PAGE_SIZE + FEEDS_PAGE_SIZE);
    feedsPager.style.display = pages > 1 ? '' : 'none';
    feedPageLabel.textContent = t.pageOf(feedPage + 1, pages, rows.length);
    feedsPrevBtn.disabled = feedPage <= 0;
    feedsNextBtn.disabled = feedPage >= pages - 1;
    // 空态:整个表格不渲染,只留标题/说明与「添加订阅」入口。
    feedsTable.el.style.display = pageRows.length === 0 ? 'none' : '';

    feedsTable.clear();
    for (const feed of pageRows) {
      const nameCell = ctx.ui.h('div', null, feed.title);
      const urlLine = ctx.ui.h('div', null, feed.url);
      urlLine.style.opacity = '0.6';
      urlLine.style.wordBreak = 'break-all';
      urlLine.style.fontSize = '0.85em';
      nameCell.appendChild(urlLine);

      const statusText = feed.paused ? t.pausedBadge
        : feed.consecutiveErrors > 0 ? t.errorShort(feed.consecutiveErrors)
          : t.lampPollOnline;
      const statusEl = ctx.ui.pill(statusText, feed.paused || feed.consecutiveErrors > 0 ? 'off' : 'on');
      if (feed.consecutiveErrors > 0 && feed.lastError) statusEl.title = feed.lastError;

      const actions = ctx.ui.rowbar();
      // .btn.sm 自带 11px 水平内边距,会把按钮文字推离表头文字;拉回一个内边距,
      // 让按钮文字与「操作」表头文字对齐、按钮盒子齐平列边界。
      actions.style.marginLeft = '-11px';
      actions.append(ctx.ui.button(t.detail, {
        size: 'sm',
        onClick: () => openDetailDialog(feed),
      }));
      actions.append(ctx.ui.button(t.pull, {
        size: 'sm',
        onClick: () => void locked(async () => {
          const result = await ctx.invoke<RefreshResult>('feeds.refresh', [{ id: feed.id }]);
          const one = result.results[0];
          show(one ? t.pullOne(feed.title, one.newCount, one.notModified, one.error) : t.failed);
          await refresh();
        }),
      }));
      actions.append(ctx.ui.button(feed.paused ? t.resume : t.pause, {
        size: 'sm',
        onClick: () => void locked(async () => {
          await ctx.invoke('feeds.update', [{ id: feed.id, patch: { paused: !feed.paused } }]);
          await refresh();
        }),
      }));
      actions.append(ctx.ui.button(t.remove, {
        size: 'sm',
        variant: 'danger',
        onClick: () => void locked(async () => {
          const confirmed = await ctx.ui.confirm({ title: t.remove, body: t.removeConfirm(feed.title), danger: true });
          if (!confirmed) return;
          await ctx.invoke('feeds.remove', [{ id: feed.id }]);
          show(t.removed(feed.title));
          await refresh();
        }),
      }));

      const tr = feedsTable.addRow([
        { el: nameCell },
        { el: statusEl },
        feed.unread > 0 ? { el: ctx.ui.chip(String(feed.unread), 'warn') } : '0',
        { el: actions },
      ]);
      // 水平:状态/未读居中(表头一致),标题/操作左对齐。
      // 垂直:全列居中——宿主表格 td 默认 vertical-align: top,多行内容的行里
      // 单行元素会顶到上沿。行内嵌的 rowbar 自带 margin-bottom,会把居中重心顶歪,一并清零。
      for (const cell of [tr.children[0], tr.children[1], tr.children[2], tr.children[3]]) {
        (cell as HTMLElement).style.verticalAlign = 'middle';
      }
      const statusTd = tr.children[1] as HTMLElement | undefined;
      const unreadTd = tr.children[2] as HTMLElement | undefined;
      if (statusTd) statusTd.style.textAlign = 'center';
      if (unreadTd) unreadTd.style.textAlign = 'center';
      actions.style.marginBottom = '0';
    }
  }

  const refresh = async (): Promise<void> => {
    try {
      const overview = await ctx.invoke<Overview>('overview');
      cardFeeds.value.textContent = String(overview.feeds);
      cardUnread.value.textContent = String(overview.unread);
      cardUnread.value.parentElement?.classList.toggle('accent', overview.unread > 0);
      cardFresh.value.textContent = String(overview.fetched24h);
      defaultUserAgent = overview.defaultUserAgent;
      renderFeeds(await ctx.invoke<FeedRow[]>('feeds.list'));
    } catch (error) {
      show(`${t.loadError}: ${errorText(error)}`, true);
    }
  };

  const locked = async (task: () => Promise<void>): Promise<void> => {
    const lock = ctx.ui.disable(pullAllBtn);
    try {
      await task();
    } catch (error) {
      show(`${t.failed}: ${errorText(error)}`, true);
    } finally {
      lock.dispose();
    }
  };

  void refresh();
}

/** OPML 面板:导出 / 导入(选文件与粘贴文本两条独立路径)。 */
function mountOpml(ctx: WebUiPanelContext): void {
  const t = text(ctx.language);
  const message = ctx.ui.msgline();
  const show = (body: string, bad = false): void => {
    message.textContent = body;
    message.classList.toggle('bad', bad);
  };

  const runImport = (content: string): Promise<void> =>
    locked(async () => {
      if (!content.trim()) return;
      const result = await ctx.invoke<{ ok: number; fail: number; total: number }>('opml.import', [{ opml: content }]);
      show(t.opmlImported(result.ok, result.fail));
    });

  const pickFile = (): Promise<string> => new Promise<string>((resolve) => {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.opml,.xml,text/xml';
    picker.onchange = () => {
      const file = picker.files?.[0];
      if (!file) { resolve(''); return; }
      void file.text().then(resolve);
    };
    picker.click();
  });

  // ── 导出 ────────────────────────────────────────────────────────────
  const exportSheet = ctx.ui.sheet({ title: t.opmlExportTitle, desc: t.opmlExportDesc });
  const exportBtn = ctx.ui.button(t.exportLabel, {
    variant: 'primary',
    onClick: () => void locked(async () => {
      const result = await ctx.invoke<{ opml: string }>('opml.export');
      const blob = new Blob([result.opml], { type: 'text/xml' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'coopanion-rss.opml';
      link.click();
      URL.revokeObjectURL(link.href);
      show(t.opmlExported);
    }),
  });
  const exportBar = ctx.ui.rowbar();
  exportBar.appendChild(exportBtn);
  exportSheet.body.appendChild(exportBar);
  ctx.root.appendChild(exportSheet.el);

  // ── 导入:路径一,选择文件 ──────────────────────────────────────────
  const importSheet = ctx.ui.sheet({ title: t.opmlImportTitle, desc: t.opmlImportDesc });
  const fileBtn = ctx.ui.button(t.pickFile, {
    variant: 'primary',
    onClick: () => void pickFile().then((content) => runImport(content)),
  });
  const fileBar = ctx.ui.rowbar();
  fileBar.appendChild(fileBtn);
  importSheet.body.appendChild(fileBar);

  // ── 导入:路径二,粘贴文本 ──────────────────────────────────────────
  const pasteLabel = ctx.ui.h('div', null, t.pasteLabel);
  pasteLabel.style.margin = '8px 0 4px';
  importSheet.body.appendChild(pasteLabel);
  const importArea = ctx.ui.textarea({ rows: 6, placeholder: t.pastePlaceholder });
  importSheet.body.appendChild(importArea);
  const pasteBtn = ctx.ui.button(t.importPasted, {
    variant: 'primary',
    onClick: () => void runImport(importArea.value).then(() => { importArea.value = ''; }),
  });
  const pasteBar = ctx.ui.rowbar();
  pasteBar.appendChild(pasteBtn);
  importSheet.body.appendChild(pasteBar);

  ctx.root.appendChild(importSheet.el);
  ctx.root.appendChild(message);

  const locked = async (task: () => Promise<void>): Promise<void> => {
    const lock = ctx.ui.disable(exportBtn, fileBtn, pasteBtn);
    try {
      await task();
    } catch (error) {
      show(`${t.failed}: ${errorText(error)}`, true);
    } finally {
      lock.dispose();
    }
  };
}

/**
 * 配置表单的通用装配:按字段说明铺 field,一个保存按钮收全部值提交 config.save。
 * 字段说明 kind:number(string 输入)/string/time(时间选择器)/bool/enum(select)。
 */
interface FieldSpec {
  key: string;
  label: string;
  kind: 'number' | 'string' | 'time' | 'bool' | 'enum';
  options?: ReadonlyArray<{ value: string; label: string }>;
  placeholder?: string;
  /** 说明小字;bool 渲染为勾选框旁的 ⓘ 提示。 */
  hint?: string;
}

/** 单个字段的取值/回填;复合控件在闭包里自行组装与拆解。 */
interface FieldReader {
  read(): string | number | boolean;
  write(raw: unknown): void;
}

function mountConfigForm(
  ctx: WebUiPanelContext,
  sheets: Array<{ title: string; desc?: string; fields: FieldSpec[] }>,
  onSaved: (restartRequired: boolean) => void,
): void {
  const t = text(ctx.language);
  const message = ctx.ui.msgline();
  const show = (body: string, bad = false): void => {
    message.textContent = body;
    message.classList.toggle('bad', bad);
  };
  /** 非布尔字段的说明:把 `!` 提示标记追加到字段标签右侧。 */
  const attachHint = (el: HTMLElement, hint?: string): void => {
    if (!hint) return;
    const caption = el.querySelector('.fieldlabel');
    if (caption) caption.appendChild(fieldHintMark(ctx, hint));
  };
  const readers = new Map<string, FieldReader>();

  for (const sheetSpec of sheets) {
    const sheet = ctx.ui.sheet({ title: sheetSpec.title, desc: sheetSpec.desc });
    for (const field of sheetSpec.fields) {
      if (field.kind === 'bool') {
        const check = ctx.ui.checkbox(field.label);
        readers.set(field.key, {
          read: () => check.checked,
          write: (raw) => check.setChecked(raw === true),
        });
        if (field.hint) check.el.appendChild(hintMark(ctx, field.hint));
        check.el.style.marginTop = '14px';
        // label.check 是 inline-flex:相邻 bool 会被排成一行,套一层块级容器保证各占一行。
        const boolRow = ctx.ui.h('div', null);
        boolRow.appendChild(check.el);
        sheet.body.appendChild(boolRow);
      } else if (field.kind === 'enum') {
        const select = ctx.ui.select();
        for (const option of field.options ?? []) select.appendChild(new Option(option.label, option.value));
        readers.set(field.key, {
          read: () => select.value,
          write: (raw) => { select.value = raw == null ? '' : String(raw); },
        });
        const selectField = ctx.ui.field(field.label, select);
        attachHint(selectField, field.hint);
        sheet.body.appendChild(selectField);
      } else {
        const input = ctx.ui.input({ type: field.kind === 'number' ? 'number' : 'text', placeholder: field.placeholder });
        if (field.kind === 'time') input.type = 'time';
        readers.set(field.key, {
          read: () => input.value,
          write: (raw) => { input.value = field.kind === 'time' ? timeValue(raw) : raw == null ? '' : String(raw); },
        });
        const textField = ctx.ui.field(field.label, input);
        attachHint(textField, field.hint);
        sheet.body.appendChild(textField);
      }
    }
    ctx.root.appendChild(sheet.el);
  }

  const saveBtn = ctx.ui.button(t.saveConfig, {
    variant: 'primary',
    onClick: () => void locked(async () => {
      const patch: ConfigValues = {};
      for (const [key, reader] of readers) patch[key] = reader.read();
      const result = await ctx.invoke<{ ok: boolean; restartRequired: boolean }>('config.save', [patch]);
      show(result.restartRequired ? `${t.savedConfig} ${t.restartHint}` : t.savedConfig, result.restartRequired);
      onSaved(result.restartRequired);
    }),
  });
  const saveBar = ctx.ui.rowbar();
  saveBar.appendChild(saveBtn);
  ctx.root.appendChild(saveBar);
  ctx.root.appendChild(message);

  const locked = async (task: () => Promise<void>): Promise<void> => {
    const lock = ctx.ui.disable(saveBtn);
    try {
      await task();
    } catch (error) {
      show(`${t.failed}: ${errorText(error)}`, true);
    } finally {
      lock.dispose();
    }
  };

  // 预填当前值。
  void (async () => {
    try {
      const values = await ctx.invoke<ConfigValues>('config.get');
      for (const [key, reader] of readers) reader.write(values[key]);
    } catch (error) {
      show(`${t.loadError}: ${errorText(error)}`, true);
    }
  })();
}

/** 通知标签:打扰时机 + 合批与关键词。 */
function mountNotify(ctx: WebUiPanelContext): void {
  const t = text(ctx.language);
  mountConfigForm(ctx, [
    {
      title: t.sheetDisturbTitle,
      desc: t.sheetDisturbDesc,
      fields: [
        { key: 'digestEnabled', label: t.digestEnabledTitle, kind: 'bool', hint: t.digestEnabledDescription },
        { key: 'digestTime', label: t.digestTimeTitle, kind: 'time' },
        { key: 'startupNotify', label: t.startupNotifyTitle, kind: 'bool', hint: t.startupNotifyDescription },
        { key: 'autoMarkReadOnNotify', label: t.autoMarkTitle, kind: 'bool' },
      ],
    },
    {
      title: t.sheetBatchTitle,
      fields: [
        { key: 'eventBatchSeconds', label: t.eventBatchTitle, kind: 'number', hint: t.eventBatchDescription },
        { key: 'eventMaxHeadlines', label: t.eventMaxHeadlinesTitle, kind: 'number', hint: t.eventMaxHeadlinesDescription },
        { key: 'eventMaxChars', label: t.eventMaxCharsTitle, kind: 'number' },
      ],
    },
  ], () => {});
}

/** 设置标签:轮询与网络 + 阅读与数据。 */
function mountSettings(ctx: WebUiPanelContext): void {
  const t = text(ctx.language);
  mountConfigForm(ctx, [
    {
      title: t.groupPollingTitle,
      desc: t.groupPollingDescription,
      fields: [
        { key: 'pollIntervalMinutes', label: t.pollIntervalTitle, kind: 'number' },
        { key: 'pollConcurrency', label: t.pollConcurrencyTitle, kind: 'number' },
        { key: 'requestTimeoutMs', label: t.requestTimeoutTitle, kind: 'number' },
        { key: 'maxFeeds', label: t.maxFeedsTitle, kind: 'number' },
      ],
    },
    {
      title: t.groupDataTitle,
      desc: t.groupDataDescription,
      fields: [
        { key: 'retentionDays', label: t.retentionTitle, kind: 'number' },
        { key: 'maxItemsTotal', label: t.maxItemsTotalTitle, kind: 'number' },
        { key: 'maxItemsPerFeed', label: t.maxItemsPerFeedTitle, kind: 'number' },
        { key: 'baselineAsRead', label: t.baselineAsReadTitle, kind: 'bool', hint: t.baselineAsReadDescription },
      ],
    },
  ], () => {});
}

const feedsPanel: WebUiPanel = { mount: mountFeeds };
const inboxPanel: WebUiPanel = { mount: mountInbox };
const notifyPanel: WebUiPanel = { mount: mountNotify };
const settingsPanel: WebUiPanel = { mount: mountSettings };
const opmlPanel: WebUiPanel = { mount: mountOpml };

const bundle: WebUiClientBundle = {
  panels: {
    feeds: feedsPanel,
    inbox: inboxPanel,
    notify: notifyPanel,
    settings: settingsPanel,
    opml: opmlPanel,
  },
};

export default bundle;

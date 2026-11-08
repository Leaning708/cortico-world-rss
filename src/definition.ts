import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { RSS_DEFAULTS, type RssConfigSection } from './config.ts';
import { RSS_EVENT_DESCS, RSS_SUMMARIES, RSS_TOOL_DECLS, RssWorld } from './world.ts';

/** 默认导出的 World 定义;id 同时是配置段 worlds.rss 与 WebUI 页 world:rss。 */
export const RSS: WorldDefinition<RssConfigSection> = {
  id: 'rss',
  label: 'RSS 订阅',
  // `ctx.cfg` 是 worlds.rss 的活引用:轮询间隔、免打扰、关键词等热改即生效。
  defaults: () => ({ ...RSS_DEFAULTS }),
  create: (ctx) => new RssWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    dataDir: ctx.dataDir,
    // 面板 config.save 的写回通道:活对象与 config.json 同步(ctx.persist 深合并 worlds.rss)。
    persist: (patch) => ctx.persist(patch),
    log: {
      info: () => {},
      warn: (message) => {
        // 没有宿主日志可用时先落 console.warn;start(host) 后由 host.log 接管。
        console.warn(`[world:rss] ${message}`);
      },
    },
  }),
  // 自描述:可能出现的全部工具与会推出的全部事件,不进提示词。
  describe: {
    tools: describeTools(RSS_TOOL_DECLS, RSS_SUMMARIES),
    events: RSS_EVENT_DESCS.map((event) => ({ ...event })),
  },
};

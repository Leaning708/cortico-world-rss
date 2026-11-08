/** 插件版本:从包根 package.json 现读,升级后 UA 自动跟着变。 */
import { createRequire } from 'node:module';

const pkg = createRequire(import.meta.url)('../package.json') as { version?: string };

export const PLUGIN_VERSION = pkg.version ?? '0.0.0';

/** 拉取源与文章页时对外声明的默认 User-Agent(单源可覆盖)。 */
export const DEFAULT_USER_AGENT = `Coopanion RSS Reader/${PLUGIN_VERSION}`;

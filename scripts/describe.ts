/**
 * 本机替代 `pnpm describe:extension`:没有 Cortico 检出时,用已安装的 `cortico`
 * 在临时假部署里构造 World,把自描述写进 describe.json。
 * 用法:`node <node.exe> "…/pnpm.mjs" run describe:local`
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { RSS } from '../src/definition.ts';

const scratch = mkdtempSync(join(tmpdir(), 'rss-describe-'));
let content: string;

try {
  const world = RSS.create(fakeWorldContext(RSS, {
    scratchDir: scratch,
    packageDir: join(scratch, 'package'),
  }));
  const doc = world.webUi?.('zh').promptDocs?.find((entry) => entry.role === 'envPrompt');
  if (!doc) throw new Error('the World does not declare an envPrompt promptDoc');

  const describe = {
    tools: RSS.describe?.tools ?? [],
    events: RSS.describe?.events ?? [],
    prompts: [{
      key: doc.key,
      title: doc.title,
      role: doc.role,
      content: readFileSync(doc.path, 'utf8'),
    }],
  };
  content = `${JSON.stringify(describe, null, 2)}\n`;
  console.log(`describe.json written: ${describe.tools.length} tools, ${describe.events.length} events, ${describe.prompts.length} prompt`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

writeFileSync('describe.json', content, 'utf8');

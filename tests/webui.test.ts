import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('WebUI 产物', () => {
  const dist = join(process.cwd(), 'dist', 'webui.js');

  it('dist/webui.js 存在且为 ESM', () => {
    expect(existsSync(dist)).toBe(true);
    const source = readFileSync(dist, 'utf8');
    expect(/export\s*(default|\{[^}]*default)/.test(source)).toBe(true);
    expect(source).not.toContain('require(');
  });

  it('manifest 指向面板产物', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      cortico: { webUiClient?: string; kind?: string; api?: number };
    };
    expect(manifest.cortico.webUiClient).toBe('dist/webui.js');
    expect(manifest.cortico.kind).toBe('world');
    expect(manifest.cortico.api).toBe(6);
  });

  it('bundle 默认导出五个标签面板', async () => {
    const mod = (await import(dist as unknown as string)) as { default: { panels: Record<string, unknown> } };
    expect(Object.keys(mod.default.panels)).toEqual(['feeds', 'inbox', 'notify', 'settings', 'opml']);
  });
});

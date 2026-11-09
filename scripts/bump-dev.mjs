#!/usr/bin/env node
/**
 * 开发期递增预发布版本:0.3.0 -> 0.3.0-dev.1 -> 0.3.0-dev.2 …
 * 用于面板产物的 immutable 缓存换键;发布时手动改回 X.Y.Z,不要发布 -dev.N。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../package.json', import.meta.url);
const text = readFileSync(path, 'utf8');
const current = JSON.parse(text).version ?? '';
const match = /^(\d+\.\d+\.\d+)(?:-dev\.(\d+))?$/.exec(current);
if (!match) {
  console.error(`当前版本 ${current} 不是 X.Y.Z 或 X.Y.Z-dev.N,先手动改成基础版本。`);
  process.exit(1);
}
const next = match[2] ? Number(match[2]) + 1 : 1;
const version = `${match[1]}-dev.${next}`;
const updated = text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
writeFileSync(path, updated, 'utf8');
console.log(`${current} -> ${version}`);

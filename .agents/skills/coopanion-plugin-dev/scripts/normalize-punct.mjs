// 中文文案标点规范化:紧贴汉字的半角 , ; ? ! : 转全角(ASCII 语境不动)。
// 用法:node normalize-punct.mjs <文件...> [--apply](不带 --apply 只预览)
// 适用于 cortico-world-* 扩展的 strings.ts / world.ts 等含中文文案的源文件。
import fs from 'node:fs';

const CJK = '\\u4e00-\\u9fff\\u300c\\u300d\\u300e\\u300f\\u3010\\u3011\\uff08\\uff09';
// 全角替换字符用码点构造,避免源文件自身的半角/全角歧义(替换串里的 \uXXXX 是字面文本!)。
const FW = {
  ',': String.fromCodePoint(0xff0c),
  ';': String.fromCodePoint(0xff1b),
  '?': String.fromCodePoint(0xff1f),
  '!': String.fromCodePoint(0xff01),
  ':': String.fromCodePoint(0xff1a),
};
const rules = [
  [new RegExp(`([${CJK}0-9]),(?=[${CJK}0-9a-zA-Z])`, 'g'), FW[',']],
  [new RegExp(`([${CJK}]);(?=[${CJK}0-9a-zA-Z])`, 'g'), FW[';']],
  [new RegExp(`([${CJK}\\uff09])\\?(?=\\s?[${CJK}])`, 'g'), FW['?']],
  [new RegExp(`([${CJK}])!(?=\\s?[${CJK}])`, 'g'), FW['!']],
  [new RegExp(`([${CJK}\\uff09]):(?=[${CJK}0-9a-zA-Z])`, 'g'), FW[':']],
];

const files = process.argv.slice(2).filter((a) => a !== '--apply');
const apply = process.argv.includes('--apply');
if (files.length === 0) {
  console.log('用法:node normalize-punct.mjs <文件...> [--apply]');
  process.exit(1);
}

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  let out = src;
  let count = 0;
  for (const [re, to] of rules) {
    for (const m of out.matchAll(re)) count += 1;
    out = out.replace(re, `$1${to}`);
  }
  console.log(`${file}: ${count} 处半角标点${apply ? ' 已规范化' : '(预览)'}`);
  // 残留复查:仍紧贴汉字的半角标点(代码语境的除外,自行判断)
  for (const m of out.matchAll(new RegExp(`[^\\n]*[${CJK}][,:;?!][^\\n]*`, 'g'))) {
    if (!m[0].includes('//')) console.log('  残留半角: ' + m[0].trim().slice(0, 80));
  }
  if (apply && out !== src) fs.writeFileSync(file, out);
}
if (!apply) console.log('(预览模式,加 --apply 落盘)');

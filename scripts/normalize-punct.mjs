// 临时工具:把 zh 文案里紧贴汉字的半角标点(,;?!:)规范成全角。
// 用法:node scripts/normalize-punct.mjs [--apply](不带 --apply 只预览)
import fs from 'node:fs';

const CJK = '\\u4e00-\\u9fff\\u300c\\u300d\\u300e\\u300f\\u3010\\u3011\\uff08\\uff09';
// 全角替换字符用码点构造,避免源文件自身的半角/全角歧义。
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
  // 全角?后多余空格(历史遗留的半角补偿)清掉
  [new RegExp('(\\uFF1F) (?=[${CJK}])'.replace('${CJK}', CJK), 'g'), '$1'],
];

const apply = process.argv.includes('--apply');
for (const file of ['src/strings.ts', 'src/world.ts']) {
  const src = fs.readFileSync(file, 'utf8');
  const zhStart = file.endsWith('strings.ts') ? src.indexOf('const zh = {') : 0;
  const zhEnd = file.endsWith('strings.ts') ? src.indexOf('const en: typeof zh') : src.length;
  const zh = src.slice(zhStart, zhEnd);
  let out = zh;
  let count = 0;
  for (const [re, to] of rules) {
    for (const m of out.matchAll(re)) count += 1;
    out = out.replace(re, `$1${to}`);
  }
  console.log(`${file}: ${count} 处半角标点${apply ? ' 已规范化' : '(预览)'}`);
  for (const m of out.matchAll(new RegExp(`[^\\n]*[${CJK}][,:;?!][^\\n]*`, 'g'))) {
    if (!m[0].includes('//')) console.log('  残留半角: ' + m[0].trim().slice(0, 80));
  }
  if (apply) {
    fs.writeFileSync(file, src.slice(0, zhStart) + out + src.slice(zhEnd));
  }
}
if (!apply) console.log('(预览模式,加 --apply 落盘)');

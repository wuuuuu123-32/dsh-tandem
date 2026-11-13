/**
 * 验证会审提的两条：①opus 的答案为什么被判 invalid_answer（内容看起来合规）；
 * ②insideRoots 在 Windows 混用分隔符/大小写时是否误判。
 */
import { stripCodeFence } from '../lib/consult.js';
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { collectMaterials } from '../lib/consult.js';

console.log('=== ① 复现 opus 被判 invalid_answer');
const t = readFileSync('C:/Users/123/.dsh/tandem-state/_tandem/consult-1794503702550-2-4es7/consult.log', 'utf8');
let raw = null;
for (const l of t.split(/\r?\n/)) {
  if (!l.trim().startsWith('{')) continue;
  try { const ev = JSON.parse(l); if (ev.item && ev.item.type === 'agent_message') raw = ev.item.text; } catch {}
}
console.log('原文长度 ' + raw.length + '，开头 ' + JSON.stringify(raw.slice(0, 12)) + '，结尾 ' + JSON.stringify(raw.slice(-12)));
const cleaned = stripCodeFence(raw);
console.log('剥后开头 ' + JSON.stringify(cleaned.slice(0, 12)) + '，结尾 ' + JSON.stringify(cleaned.slice(-12)));
let parsed = null;
try { parsed = JSON.parse(cleaned); } catch (e) { console.log('解析失败: ' + e.message); }
if (parsed) {
  console.log('字段: ' + Object.keys(parsed).join(','));
  for (const k of ['conclusion', 'evidence', 'counterexamples', 'verification']) {
    const v = parsed[k];
    console.log('  ' + k + ': ' + (Array.isArray(v) ? 'array(' + v.length + ')' : typeof v) + ' 空=' + (Array.isArray(v) ? v.length === 0 : String(v || '').trim() === ''));
  }
}

console.log('\n=== ② insideRoots 混用分隔符');
const root = 'D:/dsh/config/.tmp-sep-test';
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
mkdirSync(root + '/sub', { recursive: true });
writeFileSync(root + '/sub/a.txt', 'x\n');
const variants = [
  ['纯正斜杠', root + '/sub/a.txt'],
  ['纯反斜杠', root.replace(/\//g, '\\') + '\\sub\\a.txt'],
  ['混杂：根正斜杠 + 文件反斜杠', root + '\\sub\\a.txt'],
  ['混杂：根反斜杠 + 文件正斜杠', root.replace(/\//g, '\\') + '/sub/a.txt'],
  ['小写盘符', root.toLowerCase() + '/sub/a.txt'],
];
for (const [name, p] of variants) {
  const r = collectMaterials([p], { roots: [root], base: root });
  const ok = r.items.length === 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + ' → ' + (ok ? '读入' : r.rejected[0].reason));
}
rmSync(root, { recursive: true, force: true });

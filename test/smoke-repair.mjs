import { repairJsonEscapes, stripCodeFence } from '../lib/consult.js';

// 拿 opus 那份真实回答来验：修完之后必须能解析，且四段都在
import { readFileSync } from 'node:fs';
const t = readFileSync('C:/Users/123/.dsh/tandem-state/_tandem/consult-1794503702550-2-4es7/consult.log', 'utf8');
let raw = null;
for (const l of t.split(/\r?\n/)) {
  if (!l.trim().startsWith('{')) continue;
  try { const ev = JSON.parse(l); if (ev.item && ev.item.type === 'agent_message') raw = ev.item.text; } catch {}
}
const cleaned = stripCodeFence(raw);
let direct = null;
try { direct = JSON.parse(cleaned); } catch {}
const repairedText = repairJsonEscapes(cleaned);
let fixed = null;
try { fixed = JSON.parse(repairedText); } catch (e) { console.log('修复后仍失败: ' + e.message); }
console.log('原始解析: ' + (direct ? '成功' : '失败'));
console.log('修复后解析: ' + (fixed ? '成功' : '失败'));
if (fixed) {
  console.log('  字段: ' + Object.keys(fixed).join(','));
  console.log('  conclusion 长度 ' + fixed.conclusion.length + '，evidence ' + fixed.evidence.length + ' 条，counterexamples ' + fixed.counterexamples.length + ' 条，verification ' + fixed.verification.length + ' 字');
}
console.log('');

const cases = [
  ['非法 \\. 被补齐', '{"a":"x\\\\.y"}', '{"a":"x\\\\.y"}', true],
  ['合法 \\n 不动', '{"a":"l1\\nl2"}', '{"a":"l1\\nl2"}', true],
  ['合法 \\" 不动', '{"a":"say \\"hi\\""}', '{"a":"say \\"hi\\""}', true],
  ['合法 \\\\ 不动', '{"a":"back\\\\slash"}', '{"a":"back\\\\slash"}', true],
  ['合法 \\u 不动', '{"a":"\\u4e2d"}', '{"a":"\\u4e2d"}', true],
  ['半截 \\u 被补', '{"a":"\\uZZ"}', null, true],
  // 字符串被截断（引号都没闭合）时修转义也救不回来 —— 这不是转义问题，
  // 本函数只管转义、不负责补全残缺 JSON。这一点必须写进测试，免得以后误以为它万能。
  ['截断 JSON 修不好（预期如此）', '{"a":"x\\', null, false],
];
let bad = 0;
for (const [name, input, want, shouldParse] of cases) {
  const out = repairJsonEscapes(input);
  let parsed = null;
  try { parsed = JSON.parse(out); } catch {}
  const ok = shouldParse ? parsed !== null : parsed === null;
  if (!ok) bad++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + ' → ' + JSON.stringify(out) + (parsed ? '  解析OK' : '  解析失败'));
  if (want !== null && out !== want) console.log('        期望 ' + JSON.stringify(want));
}
console.log(bad ? '\n有 ' + bad + ' 条不符' : '\n全部符合');

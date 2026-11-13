import { stripCodeFence } from '../lib/consult.js';
import { readFileSync } from 'node:fs';

const F = String.fromCharCode(96).repeat(3);
const t = readFileSync('C:/Users/123/.dsh/tandem-state/_tandem/consult-1794503299979-2-v4gn/consult.log', 'utf8');
let raw = null;
for (const l of t.split(/\r?\n/)) {
  if (!l.trim().startsWith('{')) continue;
  try { const ev = JSON.parse(l); if (ev.item && ev.item.type === 'agent_message') raw = ev.item.text; } catch {}
}
console.log('raw starts:', JSON.stringify(raw.slice(0, 20)));
const c = stripCodeFence(raw);
console.log('cleaned starts:', JSON.stringify(c.slice(0, 20)));
const o = JSON.parse(c);
console.log('parsed keys:', Object.keys(o).join(','));
console.log('conclusion:', o.conclusion.slice(0, 60));

const cases = [
  ['裸 JSON', '{"a":1}', '{"a":1}'],
  ['无语言标记围栏', F + '\n{"a":1}\n' + F, '{"a":1}'],
  ['带 json 标记', F + 'json\n{"a":1}\n' + F, '{"a":1}'],
  ['未闭合围栏（不该剥）', F + 'json\n{"a":1}', F + 'json\n{"a":1}'],
  ['围栏外还有字（不该剥）', '说明如下\n' + F + 'json\n{"a":1}\n' + F, '说明如下\n' + F + 'json\n{"a":1}\n' + F],
  ['内容里含围栏', F + 'json\n{"a":"x' + F + 'y"}\n' + F, '{"a":"x' + F + 'y"}'],
  ['空输入', '', ''],
];
let bad = 0;
for (const [name, input, want] of cases) {
  const got = stripCodeFence(input);
  const ok = got === want;
  if (!ok) bad++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' → got ' + JSON.stringify(got.slice(0, 60)) + ' want ' + JSON.stringify(want.slice(0, 60))));
}
console.log(bad ? '\n有 ' + bad + ' 条不符' : '\n全部符合');
process.exit(bad ? 1 : 0);

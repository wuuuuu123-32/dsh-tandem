import { readFileSync } from 'node:fs';
import { stripCodeFence } from '../lib/consult.js';

const t = readFileSync('C:/Users/123/.dsh/tandem-state/_tandem/consult-1794503702550-2-4es7/consult.log', 'utf8');
let raw = null;
for (const l of t.split(/\r?\n/)) {
  if (!l.trim().startsWith('{')) continue;
  try { const ev = JSON.parse(l); if (ev.item && ev.item.type === 'agent_message') raw = ev.item.text; } catch {}
}
const c = stripCodeFence(raw);

// 正确的扫描：遇到 \ 时看下一个字符，然后跳过这对
const bad = [];
for (let i = 0; i < c.length - 1; i++) {
  if (c[i] !== '\\') continue;
  const next = c[i + 1];
  if (!'"\\/bfnrtu'.includes(next)) {
    bad.push({ at: i, pair: '\\' + next, ctx: c.slice(Math.max(0, i - 24), i + 10) });
    i++; // 跳过这对，避免把第二字符再当起点
    continue;
  }
  if (next === 'u') i += 5; else i++;
}
console.log('真正非法转义 ' + bad.length + ' 处：');
for (const b of bad) console.log('  pos ' + b.at + '  ' + JSON.stringify(b.pair) + '  上下文: ' + JSON.stringify(b.ctx));
console.log('');
console.log('JSON.parse 报错位置附近：');
try { JSON.parse(c); } catch (e) {
  console.log('  ' + e.message);
  const m = /position (\d+)/.exec(e.message);
  if (m) { const p = Number(m[1]); console.log('  原文: ' + JSON.stringify(c.slice(Math.max(0, p - 40), p + 20))); }
}

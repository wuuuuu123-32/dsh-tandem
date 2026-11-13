// 把一个大 diff 按 hunk 边界切成若干块，每块都带 git 头 —— 给会审当材料用。
// 为什么需要：collectMaterials 的单文件上限是 60KB，超出就截断，而**截断的文件不算覆盖**，
// 于是会审会因为「材料不全」被自己的闸门拒绝。按 hunk 切则每块都是完整、自洽的 diff。
// 用法：node split-diff.mjs <in.diff> <outPrefix> [每块上限字节，默认 55000]
import { readFileSync, writeFileSync } from 'node:fs';

const [inp, prefix, limArg] = process.argv.slice(2);
const limit = Number(limArg) || 55000;
const lines = readFileSync(inp, 'utf8').split('\n').map(l => l.replace(/\r+$/, ''));

const header = [];
let i = 0;
// git 头 = 第一个 @@ 之前的所有行（含 diff --git / index / --- / +++）
for (; i < lines.length; i++) { if (lines[i].startsWith('@@')) break; header.push(lines[i]); }
const headerText = header.join('\n') + '\n';
const headerBytes = Buffer.byteLength(headerText);

const hunks = [];
let cur = [];
for (; i < lines.length; i++) {
  if (lines[i].startsWith('@@') && cur.length) { hunks.push(cur.join('\n') + '\n'); cur = []; }
  cur.push(lines[i]);
}
if (cur.length) hunks.push(cur.join('\n') + '\n');

const parts = [];
let buf = '';
for (const h of hunks) {
  if (buf && headerBytes + Buffer.byteLength(buf) + Buffer.byteLength(h) > limit) { parts.push(buf); buf = ''; }
  buf += h;
}
if (buf) parts.push(buf);
if (parts.length > 1 && headerBytes + Buffer.byteLength(parts[parts.length - 1]) < limit / 3 && parts.length > 1) {
  // 尾块太小吃不饱就并不进前一块（仍可能略超，宁可多一块）
}

parts.forEach((p, k) => {
  const out = prefix + '-' + (k + 1) + '.diff';
  writeFileSync(out, headerText.replace(/\n/g, '\r\n') + p.replace(/\n/g, '\r\n'));
  console.log(out + '  ' + Buffer.byteLength(headerText + p) + 'B  ' + (p.match(/^@@/gm) || []).length + ' hunks');
});

// 冷进程核对：每个工具实际返回的顶层键，是否都在它自己的 output.schema.properties 里。
// 为什么要有这个脚本：2026-11-17 给 tandem_status 加了 rework 段却忘了在 schema 里声明，
// 于是工具每次调用都被宿主判违规（"value.rework is not a declared property"）——
// 而源码看起来完全正常。这类错只能靠「真调一次 + 拿返回值对 schema」抓到。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-schema-'));
fs.writeFileSync(path.join(root, 'tandem.json'), '{}', 'utf8');

const tools = new Map();
apply(
  { tools: { register: t => { tools.set(t.name, t); return () => {}; } }, on: () => () => {} },
  {
    configFile: path.join(root, 'tandem.json'),
    stateDir: root,
    codexCommand: 'C:\\Windows\\System32\\where.exe',
    workRoots: [root],
    reviewGuard: false,
    autoRescue: false,
    consultMaxRounds: 5,
  },
);

let ok = 0;
const bad = [];
function check(name, cond, detail = '') {
  (cond ? ok++ : bad.push(name + (detail ? ' → ' + detail : '')));
}

const exec = { agent: { session: 's:schema-probe' }, meta: { cwd: root }, name: 'tandem_status' };

async function keysAgainstSchema(toolName, callFn) {
  const tool = tools.get(toolName);
  if (!tool) { check(toolName + ' 已注册', false); return; }
  const declared = Object.keys(tool.output.schema.properties || {});
  let value;
  try { value = await callFn(tool); } catch (e) { check(toolName + ' 调用不抛错', false, String(e && e.message)); return; }
  const actual = Object.keys(value || {});
  const extra = actual.filter(k => !declared.includes(k));
  check(toolName + ' 返回键全在 schema 里', extra.length === 0, extra.length ? '未声明: ' + extra.join(', ') : `${actual.length} 个键`);
}

// ① status
await keysAgainstSchema('tandem_status', t => t.execute({}, exec));

// ② consult（design：用 where.exe 冒充执行器，会以退出码 2 失败，但返回值结构才是重点）
await keysAgainstSchema('tandem_consult', t =>
  t.execute({ mode: 'review', phase: 'design', question: '结构探针：只验证返回键是否都在 schema 里。' }, exec));

// ③ consult 第二次：被 phase-used 拒，这条分支的返回值也要合 schema
await keysAgainstSchema('tandem_consult', t =>
  t.execute({ mode: 'review', phase: 'design', question: '结构探针：第二次应当被拒。' }, exec));

// ④ consult 非法 phase：bad-phase 分支
await keysAgainstSchema('tandem_consult', t =>
  t.execute({ mode: 'review', phase: 'nope', question: '结构探针：非法阶段。' }, exec));

// ⑤ delegate 缺 acceptance：拒绝分支
await keysAgainstSchema('tandem_delegate', t =>
  t.execute({ tasks: [{ id: 'x', dir: root, prompt: 'p', timeoutMs: 10000 }] }, exec));

// ⑥ check / reject 的拒绝分支（不存在的 taskId）
await keysAgainstSchema('tandem_check', t => t.execute({ taskId: 'nope', checks: [{ cmd: 'echo hi' }] }, exec));
await keysAgainstSchema('tandem_reject', t => t.execute({ taskId: 'nope' }, exec));

// ⑦ 静态核对：所有工具的 schema 里都不能出现「execute 会返回但 schema 没写」的已知项
const statusSchema = Object.keys(tools.get('tandem_status').output.schema.properties);
check('tandem_status schema 含 rework', statusSchema.includes('rework'), statusSchema.join(','));
const consultSchema = Object.keys(tools.get('tandem_consult').output.schema.properties);
check('tandem_consult schema 含 phase', consultSchema.includes('phase'));
check('tandem_consult schema 含 rework', consultSchema.includes('rework'));

console.log('通过 ' + ok + ' / 失败 ' + bad.length);
for (const b of bad) console.log('  ✘ ' + b);
fs.rmSync(root, { recursive: true, force: true });
process.exit(bad.length ? 1 : 0);

// 观测点充分性：会审 portdan 第 5 轮说「这个观测点只封住了继承该环境变量的 Node 子进程路径，
// 不能证明所有外部执行入口都被观测」，并给了两条反例：
//   「若执行器是原生二进制、Python 或其他非 Node 程序，NODE_OPTIONS=--require 不会运行计数器」
//   「若某条路径通过已运行进程的 IPC、服务调用或其他不新建 Node 子进程的机制执行，计数器也不会记录」
// 以及一条具体缺口：「dual:true 没有单独执行断言」。
//
// 这个脚本补三件事：
//   A. 静态证明「外部执行入口只有一个」—— lib/consult.js 里 spawn( 只出现一次，用的就是 config.codexCommand。
//      只要这一条成立，「绕过门禁直接 spawn」就没有别的入口可选；NODE_OPTIONS 的 Node-only 局限也就无关了。
//   B. 用**非 Node 执行器**（where.exe，立刻退出、不连网）跑放行 + 超限两次，证明门禁不依赖执行器类型。
//   C. 单独调 dual:true，确认它也经过同一道门禁（放行时真跑、超限时 ms=0 且不建目录）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ok = [];
const bad = [];
function check(name, cond, detail = '') {
  (cond ? ok : bad).push(name + (detail ? ' → ' + detail : ''));
}

const here = path.dirname(fileURLToPath(import.meta.url));
const consultSrc = fs.readFileSync(path.join(here, '..', 'lib', 'consult.js'), 'utf8');

// ---- A. 唯一外部执行入口 ----
const spawnHits = [...consultSrc.matchAll(/\bspawn\(/g)];
const spawnSyncHits = [...consultSrc.matchAll(/\bspawnSync\(/g)];
check('lib/consult.js 里 spawn( 只出现 1 次（唯一外部执行入口）', spawnHits.length === 1, 'count=' + spawnHits.length);
const spawnLine = spawnHits.length === 1
  ? consultSrc.slice(0, spawnHits[0].index).split('\n').length
  : -1;
check('那一次 spawn 用的就是 config.codexCommand', spawnHits.length === 1 &&
  /spawn\(\s*config\.codexCommand/.test(consultSrc), 'line=' + spawnLine);
check('spawnSync 仅用于 git（与会审执行无关）', spawnSyncHits.every(m => {
  const tail = consultSrc.slice(m.index, m.index + 120);
  return /spawnSync\(\s*'git'/.test(tail);
}), 'count=' + spawnSyncHits.length);

// ---- 准备隔离环境 ----
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-gate-suff-'));
const cfgFile = path.join(root, 'tandem.json');
fs.writeFileSync(cfgFile, JSON.stringify({}), 'utf8');

const NON_NODE = process.env.COMSPEC ? 'C:\\Windows\\System32\\where.exe' : 'where';
check('非 Node 执行器存在（where.exe）', fs.existsSync('C:\\Windows\\System32\\where.exe'));

const { apply } = await import('../index.js');
const { claimRework, recordRework, PHASES } = await import('../lib/rework.js');

const tools = new Map();
const ctx = {
  tools: { register: (t) => { tools.set(t.name, t); return () => {}; } },
  on: () => () => {},
};
const dispose = apply(ctx, {
  configFile: cfgFile,
  stateDir: root,
  codexCommand: NON_NODE,   // ❗非 Node：NODE_OPTIONS 注入对它无效
  workRoots: [root],
  reviewGuard: false,
  autoRescue: false,
  consultMaxRounds: 5,
});
const tool = tools.get('tandem_consult');
check('tandem_consult 已注册', !!tool && typeof tool.execute === 'function');

function consultDirs() {
  try { return fs.readdirSync(root).filter(n => n.startsWith('consult-')).length; } catch { return 0; }
}
function fillRework(sessionKey) {
  // 两个离散的格子：没用的那格补上，已用的跳过（同一阶段硬灌必被 phase-used 拒）。
  const chain = [String(sessionKey).replace(/^s:/, '')];
  for (const p of PHASES) {
    const c = claimRework(root, { chain, phase: p, question: '灌额度 ' + sessionKey + ' ' + p, paths: [] });
    if (!c.allowed) continue;
    recordRework(root, c._ticket, { ok: false, verdicts: ['fail'], ms: 1000 });
  }
}

// ---- B. 非 Node 执行器：放行 vs 超限 ----
// ❗会话键的算法：identityOf 拿到 session='s:suff-non-node' 会算成 sessionKey='s:s:suff-non-node'。
//   第一版我直接把 's:suff-non-node' 当 sessionKey 灌额度，两边差一个前缀、完全对不上，
//   于是超限那次仍有额度、真的跑了（ms=2109 而不是 0）。这里统一用同一个派生函数。
const S1 = 's:suff-non-node';
const e1 = { agent: { session: S1 }, meta: { cwd: root }, name: 'tandem_consult' };
const d0 = consultDirs();
const r1 = await tool.execute({ mode: 'review', phase: 'design', question: '非 Node 执行器：应当被放行并真的启动进程。' }, e1);
const d1 = consultDirs();
check('非 Node 执行器放行时真的跑了（ms>0）', Number(r1.ms) > 0, 'ms=' + r1.ms);
check('非 Node 执行器放行时进入了调用（建了 consult-* 目录）', d1 > d0, d0 + ' → ' + d1);

fillRework('s:' + S1);
const d2 = consultDirs();
const r2 = await tool.execute({ mode: 'review', phase: 'design', question: '非 Node 执行器：应当被机制拦下。' }, e1);
const d3 = consultDirs();
check('非 Node 执行器超限时被拒', r2.ok === false, String(r2.error || '').slice(0, 60));
check('非 Node 执行器超限时没进入调用（目录不变）', d3 === d2, d2 + ' → ' + d3);
check('非 Node 执行器超限时 ms=0（一次都没启动）', Number(r2.ms) === 0, 'ms=' + r2.ms);

// ---- C. dual:true 单独断言 ----
// dual:true 走 runConsultParallel，它不建 consult-* 单路目录（那是 runConsult 的副作用），
// 所以这里的判据用「ms」而不是目录数 —— 目录数只对单路有意义。
const S2 = 's:suff-dual';
const e2 = { agent: { session: S2 }, meta: { cwd: root }, name: 'tandem_consult' };
const r3 = await tool.execute({ mode: 'review', phase: 'design', question: 'dual:true 单独验证：应当被放行并真的启动。', dual: true }, e2);
check('dual:true 放行时真的跑了（ms>0）', Number(r3.ms) > 0, 'ms=' + r3.ms);

fillRework('s:' + S2);
const r4 = await tool.execute({ mode: 'review', phase: 'design', question: 'dual:true 超限：应当被拦下、一次都不启动。', dual: true }, e2);
check('dual:true 超限时被拒', r4.ok === false, String(r4.error || '').slice(0, 60));
check('dual:true 超限时 ms=0', Number(r4.ms) === 0, 'ms=' + r4.ms);

try { dispose(); } catch {}
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}

console.log('通过 ' + ok.length + ' / ' + (ok.length + bad.length));
for (const s of ok) console.log('  ✔ ' + s);
for (const s of bad) console.log('  ✘ ' + s);
process.exit(bad.length ? 1 : 0);

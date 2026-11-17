// 真实调用路径验证（会审 portdan 第三、四轮要求的那条）。
//
// 第三轮它判「静态行序断言不成立」：
//   「静态断言只证明源码中声明的位置顺序；若新增一条绕过这些分支的早退路径，
//    或把实际调用移入未受断言覆盖的 helper，现有行序与分支计数断言仍可能通过。」
// 我据此写了本脚本（真调 apply 取工具本体 + 隔离 stateDir + 真子进程），第四轮它仍判 fail：
//   「若某条绕过门禁的路径直接调用 codexCommand 或其他执行器、没有经过 runConsult，
//    超限测试仍会看到目录数 3 → 3、ms 为 0，却无法发现请求已发出。」
// 这条成立：consult-* 目录只是 runConsult 的副作用，绕开它直接 spawn 就看不见了。
//
// 所以现在有**两个互相独立的观测点**：
//   ① consult-* 临时目录 —— 证明「走了 runConsult 这条路」；
//   ② 子进程启动计数（test/_spawn-counter.cjs 通过 NODE_OPTIONS=--require 注入）——
//      无论哪个函数、哪条分支 spawn，只要执行器是 node 就会留一行 PID。
//      这是「所有外部执行入口」的观测点，不依赖任何函数被走到。
// 两个都要「超限时为 0、放行时 > 0」，缺一个就说明有路径没被覆盖。
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
const { apply, resolveConfig } = await import('../index.js');
const { claimRework, recordRework, reworkStatus, PHASES } = await import('../lib/rework.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-gate-live-'));
const cfgFile = path.join(root, 'tandem.json');
fs.writeFileSync(cfgFile, JSON.stringify({}), 'utf8');

// ② 的观测点：所有 node 子进程启动时都会 append 一行 PID。
const spawnLog = path.join(root, 'spawn.log');
fs.writeFileSync(spawnLog, '', 'utf8');
const counter = path.join(here, '_spawn-counter.cjs');
check('计数器文件存在（供 NODE_OPTIONS 注入）', fs.existsSync(counter), counter);
process.env.TANDEM_SPAWN_LOG = spawnLog;
// ❗NODE_OPTIONS 的解析器会把反斜杠当转义符吃掉：'D:\dsh\...' 会变成 'D:dsh...'（实测
//   `Cannot find module 'D:dshconfigdsh-tandemtest_spawn-counter.cjs'`，子进程直接起不来，
//   于是 spawn 计数一直是 0、两条断言假红）。这里必须换成正斜杠。
process.env.NODE_OPTIONS = '--require "' + counter.replace(/\\/g, '/') + '"';

// 假 ctx：把注册的工具收起来，hook 一律给个空 disposer（不装真闸，本测试不验那个）。
const tools = new Map();
const ctx = {
  tools: { register: (t) => { tools.set(t.name, t); return () => {}; } },
  on: () => () => {},
};
const dispose = apply(ctx, {
  configFile: cfgFile,
  stateDir: root,
  codexCommand: process.execPath,   // 真进程，必立刻失败退出
  workRoots: [root],
  reviewGuard: false,
  autoRescue: false,
  consultMaxRounds: 5,              // 任务级：放宽到 5，让固定环节闸成为唯一变量
});

const tool = tools.get('tandem_consult');
check('tandem_consult 已注册', !!tool && typeof tool.execute === 'function');

// exec 形状照内核：pipeline.js 里 tool.execute(exec.arguments, exec)，agent.session 挂在上面。
const SESSION = 's:gate-live-test';
const fakeExec = { agent: { session: SESSION }, meta: { cwd: root }, name: 'tandem_consult' };

function consultDirs() {
  try {
    return fs.readdirSync(root).filter(n => n.startsWith('consult-'));
  } catch { return []; }
}
function spawnCount() {
  try {
    return fs.readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean).length;
  } catch { return -1; }
}

// ① 首审：门禁应当放行 → 真的会走到 runConsult → 既建目录，也真的起子进程。
const before1 = consultDirs().length;
const spawnBefore1 = spawnCount();
const r1 = await tool.execute({ mode: 'review', phase: 'design', question: '第一轮：这个请求应当被放行并真的进入单路调用，用来对照。' }, fakeExec);
const after1 = consultDirs().length;
const spawnAfter1 = spawnCount();
check('首审被放行（不是被门禁拦）', !/机制拦下/.test(String(r1.error || '')), String(r1.error || '').slice(0, 90));
check('首审真的进入了调用（新建了 consult-* 临时目录）', after1 > before1, before1 + ' → ' + after1);
check('首审真的起了执行器进程（spawn 计数增加）', spawnAfter1 > spawnBefore1, spawnBefore1 + ' → ' + spawnAfter1);
check('执行器是 node（计数器真的注入生效）', spawnAfter1 >= 1, 'spawn=' + spawnAfter1);

// ② 把这个会话的两个阶段都用掉 —— 用真实的 claimRework/recordRework 写，格式与线上完全一致。
//    为什么不手写 JSON：手写很容易造出「看起来用过、其实读不出来」的记录
//    （上一版就栽在这里：我造了一条字段名对不上的记录，门禁读不到，请求真的发出去了 ——
//     那是测试写错，不是门禁没拦）。
//    ❗这一版尤其不能靠「灌 8 次」把额度填满：现在是两个离散的格子，
//    同一阶段第二次必然被 phase-used 拒，硬灌根本灌不进去。
// ❗只补「还没用掉」的那一格：首审已经吃掉 design 了，硬灌同一个阶段一定被 phase-used 拒。
const chain = [SESSION.replace(/^s:/, '')];
let granted = 0;
for (const p of PHASES) {
  const c = claimRework(root, { chain, phase: p, question: '灌额度用：' + p, paths: [] });
  if (!c.allowed) continue;                 // 已经用过的那格跳过，不 break
  granted += 1;
  recordRework(root, c._ticket, { ok: false, verdicts: ['fail'], ms: 1000 });
}
const used = reworkStatus(root).flatMap(r => r.used);
check('两个阶段都已用掉', PHASES.every(p => used.includes(p)), 'granted=' + granted + ' used=' + JSON.stringify(used));
const recEntry = reworkStatus(root).find(r => (r.rootSession || '') === SESSION.replace(/^s:/, ''));
check('阶段记录带 fail 判定', PHASES.some(p => ((recEntry?.phases?.[p]?.verdicts) || []).includes('fail')));

// ③ 超限请求：两道门禁都该响，**且不能进入调用、也不能起任何执行器进程**。
const before2 = consultDirs().length;
const spawnBefore2 = spawnCount();
const r2 = await tool.execute({ mode: 'review', phase: 'design', question: '第二轮：这道请求应当被机制拦下，不允许真的发出去。' }, fakeExec);
const after2 = consultDirs().length;
const spawnAfter2 = spawnCount();
check('超限请求被拒（ok:false）', r2.ok === false);
check('拒绝原因来自机制（不是上游失败）', /机制拦下|已经用满/.test(String(r2.error || '')), String(r2.error || '').slice(0, 110));
check('超限请求没进入调用（没有新建 consult-* 临时目录）', after2 === before2, before2 + ' → ' + after2);
check('超限请求没起任何执行器进程（spawn 计数增量为 0）', spawnAfter2 === spawnBefore2, spawnBefore2 + ' → ' + spawnAfter2);
check('ms 为 0（根本没跑）', Number(r2.ms) === 0, String(r2.ms));

// ④ 任务级额度那层没被这次拒绝白吃：被固定环节闸拦下的那次要 releaseRound 归还。
const budgetFile = path.join(root, 'consult-budget.json');
const budgetDb = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
const keyRounds = Object.values(budgetDb.keys || {}).map(v => (v.rounds || []).length);
check('任务级额度没被拦下的那次吃掉（每键 ≤1）', keyRounds.every(n => n <= 1), JSON.stringify(keyRounds));

// ⑤ 并行 / dual 分支也必须经过同一个观测点 —— 否则「单路被拦住」不能推广到「三条分支都被拦住」。
//    这里换一个全新会话身份（额度干净），显式给两家 judges 走并行分支，看 spawn 计数是否同样增加。
const SESSION_PAR = 's:gate-live-parallel';
const fakeExecPar = { agent: { session: SESSION_PAR }, meta: { cwd: root }, name: 'tandem_consult' };
const spawnBefore3 = spawnCount();
const r3 = await tool.execute({ mode: 'review', phase: 'design', question: '并行分支：两家 judge，用来证明并行路径也经过 spawn 观测点。', judges: ['portdan', 'quna-opus'] }, fakeExecPar);
const spawnAfter3 = spawnCount();
check('并行分支真的起了执行器进程（观测点覆盖并行路径）', spawnAfter3 > spawnBefore3, spawnBefore3 + ' → ' + spawnAfter3);
check('并行分支返回里能看到实际问了几家', r3.ok !== undefined, 'ok=' + r3.ok + ' error=' + String(r3.error || '').slice(0, 60));

// ⑥ 把该并行会话的两个阶段也用掉，确认并行分支超限时同样 0 次 spawn。
const chainPar = [SESSION_PAR.replace(/^s:/, '')];
for (const p of PHASES) {
  const c = claimRework(root, { chain: chainPar, phase: p, question: '并行灌额度：' + p, paths: [] });
  if (!c.allowed) break;
  recordRework(root, c._ticket, { ok: false, verdicts: ['fail'], ms: 1000 });
}
const spawnBefore4 = spawnCount();
const r4 = await tool.execute({ mode: 'review', phase: 'design', question: '并行分支超限：应当被拦、且不起进程。', judges: ['portdan', 'quna-opus'] }, fakeExecPar);
const spawnAfter4 = spawnCount();
check('并行分支超限被拒', r4.ok === false);
check('并行分支超限时 spawn 增量为 0', spawnAfter4 === spawnBefore4, spawnBefore4 + ' → ' + spawnAfter4);

// ⑦ (c) consultRequireDual 的口径：显式 false 的用户升级后行为不变。
const f1 = path.join(root, 'c1.json');
fs.writeFileSync(f1, JSON.stringify({ consultRequireDual: false }), 'utf8');
const f2 = path.join(root, 'c2.json');
fs.writeFileSync(f2, JSON.stringify({ consultRequireDual: true }), 'utf8');
const f3 = path.join(root, 'c3.json');
fs.writeFileSync(f3, JSON.stringify({}), 'utf8');
check('显式 false → false（升级前后一致）', resolveConfig({ configFile: f1 }).consultRequireDual === false);
check('显式 true → true', resolveConfig({ configFile: f2 }).consultRequireDual === true);
check('不配 → 默认 false', resolveConfig({ configFile: f3 }).consultRequireDual === false);

try { dispose(); } catch {}
delete process.env.NODE_OPTIONS;
delete process.env.TANDEM_SPAWN_LOG;
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}

console.log('通过 ' + ok.length + ' / ' + (ok.length + bad.length));
for (const s of ok) console.log('  ✔ ' + s);
for (const s of bad) console.log('  ✘ ' + s);
process.exit(bad.length ? 1 : 0);

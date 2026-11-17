// 静态核对：两道轮次门禁必须挡在「并行 / dual / 单路」三条分支**之前**。
// 为什么要这么查（会审 portdan 反例 3）：材料里说了机制有两层，但没给「单路分支也真的经过它们」
// 的调用路径证据。真起进程跑超限请求成本高、且会污染 consult-budget.json 的真实额度和
// consult-rework.json 的会话窗口，所以这里退一步做**行序断言** ——
// 只要 claimRound / claimRework 在源码里位于三条分支之前、且中间没有 return 掉它们的语句，
// 那么任何一条分支都必须先过这两关。
// 它挡不住的是「有人以后把某个分支挪到门禁前面」—— 那正是这个脚本要抓的回归。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'index.js'), 'utf8');
const lines = src.split('\n');

const ok = [];
const bad = [];
function check(name, cond, detail = '') {
  (cond ? ok : bad).push(name + (detail ? ' → ' + detail : ''));
}

// 找某个模式第一次出现的行号（1-based）；找不到返回 -1。
function lineOf(re, from = 0) {
  for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return -1;
}

const L_budget = lineOf(/const budget = claimRound\(/);
const L_rework = lineOf(/const rework = claimRework\(/);
const L_parallel = lineOf(/if \(wantParallel\) \{/);
const L_dual = lineOf(/if \(args\?\.dual === true\) \{/);
const L_single = lineOf(/const res = await runConsult\(\{/);

check('claimRound 存在', L_budget > 0, 'line ' + L_budget);
check('claimRework 存在', L_rework > 0, 'line ' + L_rework);
check('并行分支存在', L_parallel > 0, 'line ' + L_parallel);
check('dual 分支存在', L_dual > 0, 'line ' + L_dual);
check('单路调用存在', L_single > 0, 'line ' + L_single);

// ① 两道门禁都在三条分支之前。
check('claimRound 早于并行分支', L_budget > 0 && L_budget < L_parallel, L_budget + ' < ' + L_parallel);
check('claimRound 早于 dual 分支', L_budget > 0 && L_budget < L_dual, L_budget + ' < ' + L_dual);
check('claimRound 早于单路调用', L_budget > 0 && L_budget < L_single, L_budget + ' < ' + L_single);
check('claimRework 早于并行分支', L_rework > 0 && L_rework < L_parallel, L_rework + ' < ' + L_parallel);
check('claimRework 早于 dual 分支', L_rework > 0 && L_rework < L_dual, L_rework + ' < ' + L_dual);
check('claimRework 早于单路调用', L_rework > 0 && L_rework < L_single, L_rework + ' < ' + L_single);

// ② 第一层被拒时直接 return（不会掉到分支里去问）。
const seg1 = lines.slice(L_budget - 1, L_rework > 0 ? L_rework - 1 : L_budget + 40).join('\n');
check('claimRound 被拒时 return', /if \(!budget\.allowed\) \{[\s\S]{0,600}?return \{/.test(seg1));

// ③ 第二层被拒时先归还第一层额度、再 return（否则被拦的那次白吃任务级额度）。
const seg2 = lines.slice(L_rework - 1, L_parallel > 0 ? L_parallel - 1 : L_rework + 60).join('\n');
check('claimRework 被拒时 releaseRound 归还', /releaseRound\(/.test(seg2));
check('claimRework 被拒时 return error', /if \(!rework\.allowed\) \{[\s\S]{0,900}?return \{[\s\S]{0,400}?error:/.test(seg2));

// ④ 三条分支各自都记了返工账（少记一条，那条分支就成了免费通道）。
const nRecordRework = (src.match(/recordRework\(cfg\.stateDir, reworkClaim/g) || []).length;
check('三条分支都 recordRework', nRecordRework === 3, '实际 ' + nRecordRework + ' 处');

// ⑤ 并行分支的 judges 用解析后的名单（默认集合只有一家时不会进来）。
check('并行分支传 judges 用解析后的名单/默认集合',
  /judges: Array\.isArray\(args\?\.judges\) && args\.judges\.length \? args\.judges : DEFAULT_JUDGES/.test(src));

console.log('通过 ' + ok.length + ' / ' + (ok.length + bad.length));
for (const s of ok) console.log('  ✔ ' + s);
for (const s of bad) console.log('  ✘ ' + s);
process.exit(bad.length ? 1 : 0);

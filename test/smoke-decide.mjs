// 凭证签发判据的离线验证。
// 这套判断是整件事里最贵的一个错：凭证的语义是「这块审过了」，
// 而它原来埋在一个 200 行 async 函数里，想验证就得真起三个 codex 进程、花 3 分钟、烧几分钱。
//
// 2026-11-13 第 5 轮会审（portdan + quna-sonnet 双双否决）之后语义又收紧了两处：
//   ⑤ 从「至少一家 pass」改成「**每一家**都 pass」（pass + unclear 不再签发）
//   ⑥ 材料覆盖从「仅多路」改成「一律要求」（单路传 failover:false 不再能绕开）
// 对应地，下面有三条旧期望被翻了过来 —— 翻的方向都是「更不容易签发」。
import { decideReview } from '../lib/consult.js';

const V = (name, verdict) => ({ judge: name, verdict });
const PATHS = ['D:/x/a.js'];
const COV = { ok: true, missing: [] };

const cases = [
  ['两家都通过 → 签发', { verdicts: [V('p', 'pass'), V('s', 'pass')], judgeCount: 2, paths: PATHS, vendors: 2, materialCoverage: COV }, true],
  // ❗核心用例：两家都骂同一个地方（没有"冲突"），绝对不能签发 —— 这是原来最大的洞
  ['两家都否决 → 不签发', { verdicts: [V('p', 'fail'), V('s', 'fail')], judgeCount: 2, paths: PATHS, vendors: 2, materialCoverage: COV }, false],
  ['一家通过一家否决 → 不签发', { verdicts: [V('p', 'pass'), V('s', 'fail')], judgeCount: 2, paths: PATHS, vendors: 2, materialCoverage: COV }, false],
  ['两家都说不出结论 → 不签发', { verdicts: [V('p', 'unclear'), V('s', 'unclear')], judgeCount: 2, paths: PATHS, vendors: 2, materialCoverage: COV }, false],
  // ❗这条原来是 true。第 5 轮会审 sonnet 指出：一家 pass 一家 unclear 时 vendors 仍数 2，
  // 凭证声称「两家独立复核」，而其中一家其实什么都没说。改成不签发。
  // 乙方案（2026-11-13 用户拍板）：pass + unclear 重新允许签发 —— 说不清的一家不算背书，
// 但不该销毁整张凭证；note 里会点名是哪几家没说清。
['一家通过一家说不清 → 签发（乙方案；note 点名没说清的那家）', { verdicts: [V('p', 'pass'), V('s', 'unclear')], judgeCount: 2, paths: PATHS, vendors: 2, materialCoverage: COV }, true],
  ['有 judge 失败 → 不签发', { verdicts: [V('p', 'pass')], failedCount: 1, judgeCount: 2, paths: PATHS, vendors: 2, materialCoverage: COV }, false],
  ['没给 paths → 不签发', { verdicts: [V('p', 'pass'), V('s', 'pass')], judgeCount: 2, paths: [], vendors: 2, materialCoverage: COV }, false],
  ['有冲突 → 不签发', { verdicts: [V('p', 'pass'), V('s', 'fail')], judgeCount: 2, paths: PATHS, conflicts: ['x'], vendors: 2, materialCoverage: COV }, false],
  ['文件在会审期间被改 → 不签发', { verdicts: [V('p', 'pass'), V('s', 'pass')], judgeCount: 2, paths: PATHS, changedDuring: true, vendors: 2, materialCoverage: COV }, false],
  ['零位 judge → 不签发', { verdicts: [], judgeCount: 0, paths: PATHS, vendors: 0, materialCoverage: COV }, false],
  ['三家全通过 → 签发', { verdicts: [V('p', 'pass'), V('s', 'pass'), V('o', 'pass')], judgeCount: 3, paths: PATHS, vendors: 2, materialCoverage: COV }, true],
  ['三家一否决 → 不签发', { verdicts: [V('p', 'pass'), V('s', 'pass'), V('o', 'fail')], judgeCount: 3, paths: PATHS, vendors: 2, materialCoverage: COV }, false],

  // ⑤ 单厂商多票：2026-11-13 会审 portdan 指出「两家同厂商通过也签，凭证就被吹大了」
  ['两家同厂商（vendors=1）→ 不签发', { verdicts: [V('p', 'pass'), V('t', 'pass')], judgeCount: 2, paths: PATHS, vendors: 1, materialCoverage: COV }, false],
  ['三家但只一家厂商 → 不签发', { verdicts: [V('a', 'pass'), V('b', 'pass'), V('c', 'pass')], judgeCount: 3, paths: PATHS, vendors: 1, materialCoverage: COV }, false],
  // 单路不受「厂商数」这条约束（否则所有既有单路调用永远签不出凭证）
  ['单路（vendors=1, judgeCount=1）有材料覆盖 → 签发', { verdicts: [V('p', 'pass')], judgeCount: 1, paths: PATHS, vendors: 1, materialCoverage: COV }, true],

  // ⑥ 受审文件必须真进了 prompt —— 三家一致指出的最要害一条
  ['多路但材料没注入（materialCoverage 缺失）→ 不签发', { verdicts: [V('p', 'pass'), V('s', 'pass')], judgeCount: 2, paths: PATHS, vendors: 2 }, false],
  ['多路但受审文件被拒（missing 非空）→ 不签发', { verdicts: [V('p', 'pass'), V('s', 'pass')], judgeCount: 2, paths: PATHS, vendors: 2, materialCoverage: { ok: false, missing: ['D:/x/a.js'] } }, false],
  // ❗这条原来是 true（单路豁免材料覆盖）。第 5 轮会审 sonnet 指出：调用方传 failover:false
  // 就走单路，只要 reply 是 pass 就能给任意 paths 签凭证 —— 材料里只有 README.md 也一样。
  // 单路可以不受「跨厂商」约束，但必须有证据，所以材料覆盖不再豁免。
  ['单路但材料没注入 → 不签发', { verdicts: [V('p', 'pass')], judgeCount: 1, paths: PATHS, vendors: 1 }, false],

  // ❗判不出方向的 verdict 不能当成「没意见」（第 5 轮会审 portdan 给的构造：
  // verdict:'bogus' 同时躲开 vetoes 与 unclear 两个过滤，旧代码能一路签出去）
  ['verdict 是未知值 → 不签发', { verdicts: [{ judge: 'p', verdict: 'bogus' }], judgeCount: 1, paths: PATHS, vendors: 1, materialCoverage: COV }, false],
  ['一家 pass 一家未知值 → 不签发', { verdicts: [V('p', 'pass'), { judge: 's', verdict: 'yes' }], judgeCount: 2, paths: PATHS, vendors: 2, materialCoverage: COV }, false],

  // ⑧ 指纹取不到要拒绝（fail-closed，不吞成「没变化」）
  ['取指纹失败 → 不签发', { verdicts: [V('p', 'pass'), V('s', 'pass')], judgeCount: 2, paths: PATHS, vendors: 2, materialCoverage: COV, fingerprintUnknown: true }, false],
];

let bad = 0;
for (const [name, input, want] of cases) {
  const got = decideReview(input);
  const ok = got.issue === want;
  if (!ok) bad++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + ' → issue=' + got.issue + '（期望 ' + want + '）');
  if (!ok) console.log('        说明：' + got.note);
}
console.log(bad ? '\n有 ' + bad + ' 条不符' : '\n全部符合（' + cases.length + ' 条）');
process.exit(bad ? 1 : 0);
// detectConflicts 的验证。
//
// ❗2026-11-13 第 5 轮会审后语义变了：方向判定改为「声明优先、正则只兜底且永不放行」，
// 所以这里必须给 judge 声明 verdict —— 没有声明的一方只会被判成 unclear，
// 而 unclear 与谁都不构成「方向相反」（旧版这份脚本只给 conclusion，已不适用）。
// 措辞层面的判定（哪些中文/英文句子该读成否决）在 smoke-verdict.mjs 里单独测。
import { detectConflicts } from '../lib/consult.js';

const J = (name, verdict, conclusion = '') => ({ judge: name, ok: true, verdict, conclusion });

const cases = [
  ['明显相反（pass vs fail）', [J('a', 'pass'), J('b', 'fail')], 1],
  ['都通过', [J('a', 'pass'), J('b', 'pass')], 0],
  ['都否决（不该算冲突）', [J('a', 'fail'), J('b', 'fail')], 0],
  ['一方说不清（不该算冲突）', [J('a', 'unclear'), J('b', 'fail')], 0],
  ['两边都说不清', [J('a', 'unclear'), J('b', 'unclear')], 0],
  ['没有声明（不给方向，不报冲突）', [{ judge: 'a', ok: true, conclusion: '可以直接用' }, J('b', 'pass')], 0],
  ['三家里一对相反', [J('a', 'pass'), J('b', 'fail'), J('c', 'pass')], 2],
  // ↑ 期望 2：a-b、b-c 各一对。三家时冲突数是「否决对数」，不是「有一处冲突」。
  ['三家全通过', [J('a', 'pass'), J('b', 'pass'), J('c', 'pass')], 0],
  ['空列表', [], 0],
];

let bad = 0;
for (const [name, list, want] of cases) {
  const got = detectConflicts(list);
  const ok = got.length === want;
  if (!ok) bad++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + ' → ' + got.length + ' 条冲突（期望 ' + want + '）');
  if (!ok) for (const g of got) console.log('        ' + g.slice(0, 140));
}
console.log(bad ? '\n有 ' + bad + ' 条不符' : '\n全部符合');
process.exit(bad ? 1 : 0);
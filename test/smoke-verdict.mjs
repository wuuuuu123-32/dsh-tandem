// verdictOf / verdictFromText 的判定表。
// ❗这份表就是「凭证该不该签发」的唯一依据，比冲突检测更要紧：
// 原来只看「两家有没有吵架」，两家都骂同一个地方反而是"没吵架"，凭证照发。
//
// 2026-11-13 第 5 轮会审后语义变了，这里分两张表：
//   ① verdictFromText —— 纯正则兜底，仍按原来的表（它只负责「读出来」，不负责签发）
//   ② verdictOf —— 签发用的判定，**单向闸门**：声明 fail/unclear 直接采纳；
//      声明 pass 时正则仍可否决；没有声明则最多给 fail，永不给 pass。
import { verdictOf, verdictFromText, detectConflicts } from '../lib/consult.js';

let bad = 0;
const chk = (ok, msg) => { if (!ok) bad++; console.log((ok ? 'PASS' : 'FAIL') + '  ' + msg); };

// ---- ① 纯正则：它该读出什么就读出什么（这一段没变，是兜底的基准）----
console.log('== verdictFromText（正则兜底本身）');
const fromText = [
  ['可以直接用', 'pass'],
  ['这段实现可以直接用', 'pass'],
  ['能直接用，没有发现风险', 'pass'],
  ['没有问题', 'pass'],
  ['未发现问题，正确', 'pass'],
  ['无需修改', 'pass'],
  ['Looks good to me', 'pass'],
  ['不能直接用', 'fail'],
  ['不建议上线', 'fail'],
  ['存在严重缺陷，必须修改', 'fail'],
  ['必须修复后才能合并', 'fail'],
  ['有内存泄漏风险', 'fail'],
  ['do not merge', 'fail'],
  ['当前证据不足，不能说可以直接用，建议暂不放行', 'fail'],
  ['不太可以直接用，建议先改掉那个逻辑', 'fail'],
  ['不一定可以接受', 'fail'],
  ['当前版本不可用，修好后可以上线', 'fail'],
  ['目前不行，修完后可以直接用', 'fail'],
  // ❗第 8 轮 portdan 的构造：明显的否决，肯定尾巴正好是 PASS 的词
  ['当前不允许合并', 'fail'],
  ['不准上线', 'fail'],
  ['不予放行', 'fail'],
  ['不得直接合并', 'fail'],
  ['不通过', 'fail'],
  ['驳回', 'fail'],
  ['需要大改', 'fail'],
  ['我不认为在现在的并发下它可以直接用', 'fail'],
  ['说它可以直接用是错误的', 'fail'],
  ['I would not approve this', 'fail'],
  ['This does not look good', 'fail'],
  ['Not LGTM', 'fail'],
  ['有问题但可以接受', 'unclear'],
  ['信息不足，需要更多上下文', 'unclear'],
  ['', 'unclear'],
  ['嗯', 'unclear'],
];
for (const [text, want] of fromText) {
  const got = verdictFromText(text);
  chk(got === want, '「' + text + '」→ ' + got + '（期望 ' + want + '）');
}

// ---- ② 签发判定：单向闸门 ----
console.log('== verdictOf（签发用的单向闸门）');
const declared = [
  // 没有声明 → 永远不给 pass（读不出声明就不能算有人背书）
  ['可以直接用', undefined, 'unclear'],
  ['没有问题', undefined, 'unclear'],
  ['Looks good to me', undefined, 'unclear'],
  // 没声明但正则读出否决 → fail
  ['不能直接用', undefined, 'fail'],
  // 声明 fail 一律 fail（即使正文写得像通过）—— 第 5 轮会审给的反例
  ['未发现问题，代码正确', 'fail', 'fail'],
  ['可以直接用', 'fail', 'fail'],
  // 声明 pass 且正文没有否决 → pass
  ['可以直接用', 'pass', 'pass'],
  ['这段实现可以用，没问题', 'pass', 'pass'],
  // 声明 pass 但正文明确否决 → 正则可否决它（单向）
  ['不能直接用', 'pass', 'fail'],
  ['I would not approve this', 'pass', 'fail'],
  ['当前版本不可用，修好后可以上线', 'pass', 'fail'],
  // 声明 unclear 直接采纳
  ['可以直接用', 'unclear', 'unclear'],
  // 中文同义词
  ['可以直接用', '通过', 'pass'],
  ['不能直接用', '否决', 'fail'],
  // 无效声明值 → 按没声明处理（最多 fail，不给 pass）
  ['可以直接用', 'bogus', 'unclear'],
  ['不能直接用', 'bogus', 'fail'],
];
for (const [text, dec, want] of declared) {
  const got = verdictOf(text, dec);
  chk(got === want, '「' + text + '」declared=' + JSON.stringify(dec) + ' → ' + got + '（期望 ' + want + '）');
}

// ---- ③ 冲突检测跟 verdictFromText 共用判定，确认没被改坏 ----
console.log('== detectConflicts');
const J = (n, c, v) => ({ judge: n, ok: true, conclusion: c, ...(v ? { verdict: v } : {}) });
const conf = [
  ['通过 vs 否决 = 冲突', [J('a', '可以直接用', 'pass'), J('b', '不能直接用', 'fail')], 1],
  ['两家都否决 = 不是冲突', [J('a', '必须修改', 'fail'), J('b', '存在严重缺陷', 'fail')], 0],
  ['两家都通过 = 不是冲突', [J('a', '没问题', 'pass'), J('b', '可以直接用', 'pass')], 0],
  ['一家说不清 = 不硬算冲突', [J('a', '有问题但可以接受', 'unclear'), J('b', '不能直接用', 'fail')], 0],
];
for (const [name, list, want] of conf) {
  const got = detectConflicts(list);
  chk(got.length === want, name + ' → ' + got.length + '（期望 ' + want + '）');
}

console.log(bad ? '\n有 ' + bad + ' 条不符' : '\n全部符合');
process.exit(bad ? 1 : 0);
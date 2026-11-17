// 会审「问几家」的验收。
//
// 历史：
//   2026-11-13 用户要求「默认必须跨厂商双跑」—— 起因是我同一天在一件事上连问 9 轮，
//   其中 8 轮为了省时间把 judges 写成 ['portdan']，交叉验证没了。
//   2026-11-17 用户决定改回「默认只问 GPT 一家」：
//   「取消默认调用双方会审，默认只使用gpt」。
//   依据是本机 397 条会审记录：quna-sonnet 成功率 64%（67 次失败 24 次），
//   portdan 94%（143 次失败 8 次）；且 sonnet 失败时整条白等（实测一次 104 秒后 codex 退出码 1）。
//
// 这个文件现在测四件事：
//   ① 默认集合只一家、且是 GPT 系（portdan / gpt-6.1-sol）；
//   ② 并行路径没被删掉：显式给两家仍然放行、vendorCount 仍然 ≥ 2；
//   ③ requireDual 的开关语义没变（默认 false，显式打开仍然拦单家）；
//   ④ 轮次上限常量还在。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_JUDGES, CONSULT_PROVIDERS, vendorCount } from '../lib/consult.js';
import { dualJudgeError, DEFAULT_MAX_ROUNDS } from '../lib/budget.js';

test('默认只问一家（2026-11-17 用户决定）', () => {
  assert.ok(Array.isArray(DEFAULT_JUDGES), 'DEFAULT_JUDGES 必须是数组');
  assert.equal(DEFAULT_JUDGES.length, 1, '默认应为单家，实际：' + JSON.stringify(DEFAULT_JUDGES));
  assert.deepEqual(DEFAULT_JUDGES, ['portdan']);
});

test('默认那一家是 GPT 系，模型名固定', () => {
  const p = CONSULT_PROVIDERS[DEFAULT_JUDGES[0]];
  assert.ok(p, '默认 judge 不在 CONSULT_PROVIDERS 里：' + DEFAULT_JUDGES[0]);
  assert.equal(p.vendor, 'openai');
  assert.equal(p.model, 'gpt-6.1-sol');
  assert.ok(p.baseURL && /^https?:\/\//.test(p.baseURL), '缺 baseURL');
});

test('并行路径仍在：显式两家仍然放行、厂商数 ≥ 2', () => {
  assert.equal(dualJudgeError(['portdan', 'quna-sonnet']), '');
  const vendors = vendorCount(['portdan', 'quna-sonnet']);
  assert.ok(vendors >= 2, '显式双跑时厂商数必须 ≥ 2，实际 ' + vendors);
});

test('requireDual 默认不生效（单家放行），显式打开仍然拦', () => {
  // 默认：不传 requireDual 视为关（与 index.js 里 cfg.consultRequireDual 默认 false 一致）
  assert.equal(dualJudgeError(['portdan'], { requireDual: false }), '');
  // 显式打开：单家被拒，两家放行 —— 这是「想回到必须两家」的出口
  assert.match(dualJudgeError(['portdan'], { requireDual: true }), /至少要两家/);
  assert.equal(dualJudgeError(['portdan', 'quna-sonnet'], { requireDual: true }), '');
});

test('轮次上限默认 2（任务级），返工层另有会话级常量', () => {
  assert.equal(DEFAULT_MAX_ROUNDS, 2);
});

// 「默认必须双跑」的验收（2026-11-13 用户要求：「你确保现在是双跑会审，最多 2 轮」）。
//
// 现实背景：同一天我在一件事上连问 9 轮，其中 8 轮为了省时间把 judges 写成
// ['portdan'] —— 表面还是「会审」，实际已经退化成单路，交叉验证没了。
// 这个文件测两件事：
//   ① 默认配置解析出来就是两家、且是不同厂商（不是同一家的两个型号）；
//   ② judges 少于两家会被机制拒绝，而显式 provider 单路仍然合法（那是调用方明说的）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_JUDGES, CONSULT_PROVIDERS, vendorCount } from '../lib/consult.js';
import { dualJudgeError, DEFAULT_MAX_ROUNDS } from '../lib/budget.js';

test('默认 judges 至少两家', () => {
  assert.ok(Array.isArray(DEFAULT_JUDGES), 'DEFAULT_JUDGES 必须是数组');
  assert.ok(DEFAULT_JUDGES.length >= 2, '默认必须双跑，实际：' + JSON.stringify(DEFAULT_JUDGES));
});

test('默认的两家必须是不同厂商（同厂商的两个型号不算交叉验证）', () => {
  const vendors = vendorCount(DEFAULT_JUDGES);
  assert.ok(vendors >= 2, '默认两家的厂商数必须 ≥ 2，实际 ' + vendors + ' 家：' + JSON.stringify(DEFAULT_JUDGES));
  const vs = DEFAULT_JUDGES.map((j) => CONSULT_PROVIDERS[j]?.vendor);
  assert.equal(new Set(vs).size, vs.length, '默认几家不能有重复厂商：' + JSON.stringify(vs));
});

test('默认的每一家都在 provider 表里、有具体模型名', () => {
  for (const j of DEFAULT_JUDGES) {
    const p = CONSULT_PROVIDERS[j];
    assert.ok(p, '默认 judge 不在 CONSULT_PROVIDERS 里：' + j);
    assert.ok(p.model && typeof p.model === 'string', j + ' 缺 model');
    assert.ok(p.baseURL && /^https?:\/\//.test(p.baseURL), j + ' 缺 baseURL');
  }
});

test('默认为 portdan + quna-sonnet（用户 2026-11-13 定的日常配置）', () => {
  assert.deepEqual(DEFAULT_JUDGES, ['portdan', 'quna-sonnet']);
  assert.equal(CONSULT_PROVIDERS['portdan'].model, 'gpt-6.1-sol');
  assert.equal(CONSULT_PROVIDERS['quna-sonnet'].model, 'claude-sonnet-5-5');
});

test('judges 只给一家 → 机制拒绝', () => {
  assert.match(dualJudgeError(['portdan']), /至少要两家/);
  assert.match(dualJudgeError(['portdan', 'portdan']), /至少要两家/, '重复同一个 provider 也只有一家');
  assert.match(dualJudgeError(['portdan', '  ']), /至少要两家/, '空白项要被过滤掉');
  assert.match(dualJudgeError([]), /至少要两家/);
  assert.match(dualJudgeError(null), /至少要两家/);
});

test('judges 给两家 → 放行', () => {
  assert.equal(dualJudgeError(['portdan', 'quna-sonnet']), '');
  // 顺序无关、可以有空白
  assert.equal(dualJudgeError([' quna-sonnet ', 'portdan']), '');
});

test('显式关掉这条路（consultRequireDual=false）才允许单家', () => {
  assert.equal(dualJudgeError(['portdan'], { requireDual: false }), '');
});

test('轮次上限默认 2', () => {
  assert.equal(DEFAULT_MAX_ROUNDS, 2);
});

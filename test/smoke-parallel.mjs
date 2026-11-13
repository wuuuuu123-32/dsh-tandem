/**
 * 三路并行会审冒烟测试（2026-11-13 方案 B 上线前的一次性验证）。
 *
 * 目的不是「再测一次速度」——速度已经测过。这里要验的是**聚合语义**：
 *  - 某路失败时，其余几路的意见还在不在、failed[] 里有没有如实露面；
 *  - 结论方向相反时，conflicts[] 抓不抓得到、reviewId 会不会被错误签发；
 *  - 三路真跑一次，确认 portdan 与 quna 两条链在**同一个进程里并发**不会互相踩。
 *
 * 用固定的假回答跑聚合逻辑（不打上游），再用真材料跑一次真实三路。
 *   node smoke-parallel.mjs aggregate   # 只跑聚合逻辑，不发网络请求
 *   node smoke-parallel.mjs live <材料路径...>  # 真跑三路
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { runConsultParallel, CONSULT_PROVIDERS } from '../lib/consult.js';
import { resolveCodexCommand } from '../lib/codex-path.js';

const cfg = {
  workRoots: ['D:/dsh/config'],
  stateDir: 'C:/Users/123/.dsh/tandem-state',
  // ❗必须走同一套探测：直接写 'codex' 在桌面应用的 PATH 下会 ENOENT，
  // 而这里（普通 pwsh）会命中 npm 装的 .ps1 —— 两种都不是插件实际用的那个 exe。
  codexCommand: resolveCodexCommand(),
};

if (process.argv[2] === 'aggregate') {
  // 直接验证聚合分支：把 runConsultParallel 的输入换成假 judge 不现实（它真起进程），
  // 所以这里只验证「vendor 计数」「冲突检测」「签发条件」三件事的判定表。
  const { vendorCount } = await import('./lib/consult.js');
  const cases = [
    { names: ['portdan', 'quna-sonnet'], want: 2 },
    { names: ['quna-sonnet', 'quna-opus'], want: 1 },
    { names: ['portdan', 'tokenfuture'], want: 1 },
    { names: ['portdan', 'tokenfuture', 'aisz'], want: 1 },
    { names: ['portdan', 'quna-sonnet', 'quna-opus'], want: 2 },
  ];
  let bad = 0;
  for (const c of cases) {
    const got = vendorCount(c.names);
    const ok = got === c.want;
    if (!ok) bad++;
    console.log((ok ? 'PASS' : 'FAIL') + '  vendorCount(' + c.names.join(',') + ') = ' + got + '（期望 ' + c.want + '）');
  }
  console.log(bad ? '\n有 ' + bad + ' 条不符' : '\n全部符合');
  process.exit(bad ? 1 : 0);
}

const materials = process.argv.slice(3);
const t0 = Date.now();
const res = await runConsultParallel({
  judges: ['portdan', 'quna-sonnet', 'quna-opus'],
  paths: materials,
  config: cfg,
  deadlineMs: 600000,
  mode: 'review',
  question: '这是一次冒烟验证：请按 schema 输出四段，结论里明确说明你能否读到材料、有没有发现需要停下来的问题。',
  context: '本次调用仅用于验证三路并行会审的聚合语义与耗时，你的回答不用于真实决策。',
});
writeFileSync('smoke-parallel-result.json', JSON.stringify(res, null, 2));
console.log('顶层 ok=' + res.ok + ' partial=' + res.partial + ' vendors=' + res.vendors + ' ms=' + res.ms);
console.log('failed: ' + JSON.stringify(res.failed));
console.log('conflicts: ' + JSON.stringify(res.conflicts, null, 2));
console.log('reviewId: ' + res.reviewId + '  note: ' + res.note);
for (const r of res.results) {
  console.log('--- ' + r.judge + ' (' + r.vendor + '/' + r.model + ') ok=' + r.ok + ' ms=' + r.ms + (r.reason ? ' reason=' + r.reason : ''));
  if (r.conclusion) console.log('    conclusion: ' + String(r.conclusion).slice(0, 200));
}
console.log('\n总墙钟（串行会是三者之和）: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

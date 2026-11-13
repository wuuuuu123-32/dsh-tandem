// 一次真跑的端到端冒烟：确认并行会审这条路在改完之后仍然能跑通。
//
// 前三轮的我都是在「改完代码 → 跑离线单测 → 直接交会审」，从没在同一次改动后
// 真跑过一遍 —— 结果就是会审本身成了唯一的集成测试，而它一次要 2 到 7 分钟。
// 这个脚本用最短的问题、不注入材料（不签凭证），只验证：
//   三路并行能起来、verdict 能用声明式拿到、返回结构里有 verdicts/failed/note。
//
//   node smoke-live.mjs
import { runConsultParallel } from '../lib/consult.js';
import { resolveCodexCommand } from '../lib/codex-path.js';

const queues = process.argv[2] ? process.argv[2].split(',') : ['portdan', 'quna-sonnet'];

const res = await runConsultParallel({
  judges: queues,
  paths: [],
  config: {
    workRoots: ['D:/dsh/config'],
    stateDir: 'C:/Users/123/.dsh/tandem-state',
    codexCommand: resolveCodexCommand(),
  },
  deadlineMs: 600000,
  timeoutMs: 240000,
  mode: 'review',
  question: '下面这个函数有没有明显的错误？\n\nfunction add(a, b) { return a + b; }\n\n判据：能不能直接用？',
  context: '这是一次连通性冒烟，不是真的评审。',
});

console.log('ok=' + res.ok + ' partial=' + res.partial + ' vendors=' + res.vendors + ' ms=' + res.ms);
console.log('verdicts=' + JSON.stringify(res.verdicts));
console.log('failed=' + JSON.stringify(res.failed));
console.log('reviewId=' + res.reviewId + '  reviewNote=' + res.reviewNote);

let bad = 0;
const check = (name, cond) => { if (!cond) bad++; console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); };
check('至少一路成功', res.ok === true);
check('judges 回显正确', Array.isArray(res.judges) && res.judges.length === queues.length);
check('verdicts 是数组', Array.isArray(res.verdicts));
check('每路都有 verdict 或失败原因', res.results.every(r => r.ok ? ['pass', 'fail', 'unclear'].includes(r.verdict) : !!r.reason));
check('failed 是数组', Array.isArray(res.failed));
check('没有 paths 时不签发凭证', res.reviewId === undefined);
check('没签发时给出原因', typeof res.reviewNote === 'string' && res.reviewNote.length > 0);
console.log(bad ? '\n有 ' + bad + ' 条不符' : '\n全部符合');
process.exit(bad ? 1 : 0);
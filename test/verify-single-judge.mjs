// 验证「默认只问一家 GPT」这条改动的实际行为（不依赖 DSH 进程，直接 import 源码）。
// 为什么要有这个脚本：插件是 link: 装的，DSH 进程在 16:18 启动、代码 18:47 才改，
// 内存里跑的还是旧代码。只看源码说「改好了」不算证据，得让它自己跑一遍。
import { DEFAULT_JUDGES, CONSULT_PROVIDERS, vendorCount } from '../lib/consult.js';
import { dualJudgeError } from '../lib/budget.js';

const ok = [];
const bad = [];
function check(name, cond, detail = '') {
  (cond ? ok : bad).push(name + (detail ? ' → ' + detail : ''));
}

// ① 默认集合
check('DEFAULT_JUDGES 只有一家', DEFAULT_JUDGES.length === 1, JSON.stringify(DEFAULT_JUDGES));
check('默认那家是 portdan / gpt-6.1-sol',
  DEFAULT_JUDGES[0] === 'portdan' && CONSULT_PROVIDERS.portdan.model === 'gpt-6.1-sol',
  CONSULT_PROVIDERS[DEFAULT_JUDGES[0]]?.model);

// ② 复刻 index.js 的 wantParallel + singleJudge 判定（原样抄逻辑，不调私有函数）。
// 会审 portdan 给的反例就落在这两个判据的**口径不一致**上：
// wantParallel 按去重后的名单判，singleJudge 却按原始数组长度判 ——
// judges:['portdan','portdan'] 于是「不并行、但也不钉住」，静默走 provider 链。
function decide({ judges, providerName = '', dual = false, failover = null } = {}) {
  const judgesGiven = Array.isArray(judges) && judges.length > 0;
  // 这一段对应 index.js:840 —— 全空白名单在更早的闸就先被拒了，不进后面的判定。
  const rejected = Array.isArray(judges) && judges.length > 0
    && !judges.some(x => String(x == null ? '' : x).trim());
  if (rejected) return { rejected: true, parallel: false, singleJudge: '', providerUsed: '' };
  const effectiveJudges = [...new Set(
    (Array.isArray(judges) && judges.length ? judges : DEFAULT_JUDGES)
      .map(n => String(n == null ? '' : n).trim()).filter(Boolean),
  )];
  const parallel = !providerName && dual !== true && typeof failover !== 'boolean'
    && !(Array.isArray(judges) && judges.length === 0)
    && !(judgesGiven && judges.length === 1)
    && effectiveJudges.length >= 2;
  // 修改后的口径：只要给了 judges 且去重后只剩一家，就把它钉死当 provider。
  const singleJudge = (judgesGiven && effectiveJudges.length === 1) ? effectiveJudges[0] : '';
  return { rejected: false, parallel, singleJudge, providerUsed: singleJudge || providerName };
}

check('不传 judges → 单路、不钉 provider（就是走默认链）', (() => {
  const d = decide({});
  return d.parallel === false && d.singleJudge === '';
})());
check('judges:[] → 单路、不钉 provider', (() => {
  const d = decide({ judges: [] });
  return d.parallel === false && d.singleJudge === '';
})());
check('judges:[portdan] → 单路且钉住 portdan', (() => {
  const d = decide({ judges: ['portdan'] });
  return d.parallel === false && d.providerUsed === 'portdan';
})());
check('judges:[portdan,quna-sonnet] → 并行（按需仍可用）', decide({ judges: ['portdan', 'quna-sonnet'] }).parallel === true);
// ❗这是会审反例的回归：重复同一家时不能「不并行还不钉住」。
check('judges:[portdan,portdan] → 单路且钉住 portdan（不能静默走链）', (() => {
  const d = decide({ judges: ['portdan', 'portdan'] });
  return d.parallel === false && d.providerUsed === 'portdan';
})());
check('judges:[portdan,"  "] → 单路且钉住 portdan（空白项去重后剩一家）', (() => {
  const d = decide({ judges: ['portdan', '  '] });
  return d.parallel === false && d.providerUsed === 'portdan';
})());
// ❗第二轮会审 portdan 反例 1 的回归：全空白名单必须被拒，不能「不并行又不钉住」静默走链。
// index.js:840 的闸在 singleJudge 之前就先 return error（源码行序由 verify-gates-order.mjs 守着），
// 这里断言「万一那道闸被删掉」，decide 也不会把它当成合法单路。
check('judges:["  "] 全空白 → 必须被拒，不能静默走链', (() => {
  const d = decide({ judges: ['  '] });
  return d.rejected === true;
})());
check('judges:["  ","\\t"] 全空白多项 → 必须被拒', (() => {
  const d = decide({ judges: ['  ', '\t'] });
  return d.rejected === true;
})());
check('judges:["  ",portdan] → 不去并行、钉住 portdan', (() => {
  const d = decide({ judges: ['  ', 'portdan'] });
  return d.parallel === false && d.providerUsed === 'portdan';
})());
check('judges:[quna-opus,quna-opus] → 钉住 quna-opus，不落回 portdan 链', (() => {
  const d = decide({ judges: ['quna-opus', 'quna-opus'] });
  return d.parallel === false && d.providerUsed === 'quna-opus';
})());
check('provider 钉死 → 单路', (() => {
  const d = decide({ providerName: 'tokenfuture' });
  return d.parallel === false && d.providerUsed === 'tokenfuture';
})());

// ③ requireDual 开关：默认关（单家放行），显式打开仍拦
check('requireDual=false 时单家放行', dualJudgeError(['portdan'], { requireDual: false }) === '');
check('requireDual=true 时单家被拒', /至少要两家/.test(dualJudgeError(['portdan'], { requireDual: true })));
check('requireDual=true 时两家放行', dualJudgeError(['portdan', 'quna-sonnet'], { requireDual: true }) === '');

// ④ 并行的厂商校验没被破坏
check('显式双跑仍是 2 家厂商', vendorCount(['portdan', 'quna-sonnet']) >= 2);

// ③ 默认「走链」不等于「换厂商」—— 会审 portdan 反例 2 要的就是这个语义。
// 不传 judges 时不钉 provider，理论上可能落到链上任意一家；只要链上全是 GPT 系，
// 「默认只问 GPT」这句话就是真的。哪天有人把 claude 加进链，这条立刻变红。
const CHAIN_NAMES = ['portdan', 'tokenfuture', 'aisz'];
check('默认链上全是 openai 系（没有把这个默认悄悄甩给 Claude）',
  CHAIN_NAMES.every(n => CONSULT_PROVIDERS[n] && CONSULT_PROVIDERS[n].vendor === 'openai'),
  CHAIN_NAMES.map(n => CONSULT_PROVIDERS[n]?.vendor + '/' + CONSULT_PROVIDERS[n]?.model).join(', '));
check('默认那家 portdan 在链上',
  CHAIN_NAMES.includes(DEFAULT_JUDGES[0]));

console.log('通过 ' + ok.length + ' / ' + (ok.length + bad.length));
for (const s of ok) console.log('  ✔ ' + s);
for (const s of bad) console.log('  ✘ ' + s);
process.exit(bad.length ? 1 : 0);

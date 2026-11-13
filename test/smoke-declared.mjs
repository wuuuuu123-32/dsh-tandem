import { normalizeVerdict, verdictOf, decideReview } from '../lib/consult.js';

// 第 10 轮 portdan 的构造：非字符串 verdict 被字符串化（String(['pass']) === 'pass'）
// 第 11 轮两家 claude 的构造：非字符串 verdict 在并行分支的 perJudge 那步被整个丢掉，
// declaredRaw 拿不到 → bogus 闸门对它不触发 → 被当成「没声明」→ 正则给 unclear →
// 乙方案下只要另一家 pass 就签发。
// 这里验的是**修完之后**的端到端行为：perJudge 必须把原始声明原样带出去。
console.log('=== 一、normalizeVerdict 只认字符串 ===');
const cases10 = [
  [['pass'], '数组 ["pass"] 不算声明', ''],
  [null, 'null 不算声明', ''],
  [123, '数字不算声明', ''],
  [{}, '对象不算声明', ''],
  [true, '布尔不算声明', ''],
  ['pass', '正常字符串仍然认', 'pass'],
  ['通过', '中文同义词仍然认', 'pass'],
  ['  PASS  ', '大小写与空白归一', 'pass'],
];
let bad = 0;
for (const [v, name, want] of cases10) {
  const got = normalizeVerdict(v);
  const flag = got === want ? 'PASS' : 'FAIL';
  if (flag === 'FAIL') bad++;
  console.log('  ' + flag + '  ' + name + ' → "' + got + '"');
}

console.log('\n=== 二、verdictOf 的单向闸门（没有声明就不给 pass） ===');
const casesV = [
  ['已核查', ['pass'], 'unclear', '正文无通过词 + 数组声明 → 最多 unclear'],
  ['可以直接用', undefined, 'unclear', '正文通过 + 无声明 → 不给 pass（只能否决不能放行）'],
  ['可以直接用', 'pass', 'pass', '正文通过 + 声明 pass → pass'],
  ['可以直接用', 'fail', 'fail', '声明 fail 压过正文'],
  ['不能直接用', 'pass', 'fail', '正文否决压过声明 pass'],
];
for (const [text, dv, want, name] of casesV) {
  const got = verdictOf(text, dv);
  const flag = got === want ? 'PASS' : 'FAIL';
  if (flag === 'FAIL') bad++;
  console.log('  ' + flag + '  ' + name + ' → ' + got);
}

console.log('\n=== 三、decideReview：非字符串声明必须被拒（第 11 轮的构造） ===');
const base = { failedCount: 0, judgeCount: 2, conflicts: [], paths: ['src/a.js'], vendors: 2, materialCoverage: { ok: true }, changedDuring: false, fingerprintUnknown: false };
const casesD = [
  {
    name: 'A 回 ["pass"] + B 回 "pass"（跨厂商）→ 不签发',
    arg: { verdicts: [{ judge: 'A', verdict: 'unclear', declaredRaw: ['pass'] }, { judge: 'B', verdict: 'pass', declaredRaw: 'pass' }], ...base },
    want: false,
  },
  {
    name: 'A 回 {} + B 回 "pass" → 不签发',
    arg: { verdicts: [{ judge: 'A', verdict: 'unclear', declaredRaw: {} }, { judge: 'B', verdict: 'pass', declaredRaw: 'pass' }], ...base },
    want: false,
  },
  {
    name: 'A 回 null + B 回 "pass" → 不签发',
    arg: { verdicts: [{ judge: 'A', verdict: 'unclear', declaredRaw: null }, { judge: 'B', verdict: 'pass', declaredRaw: 'pass' }], ...base },
    want: false,
  },
  {
    name: 'A 回 123 + B 回 "pass" → 不签发',
    arg: { verdicts: [{ judge: 'A', verdict: 'unclear', declaredRaw: 123 }, { judge: 'B', verdict: 'pass', declaredRaw: 'pass' }], ...base },
    want: false,
  },
  {
    name: '两家字符串 bogus → 不签发',
    arg: { verdicts: [{ judge: 'A', verdict: 'unclear', declaredRaw: 'bogus' }, { judge: 'B', verdict: 'pass', declaredRaw: 'pass' }], ...base },
    want: false,
  },
  {
    name: '两家都 pass → 签发',
    arg: { verdicts: [{ judge: 'A', verdict: 'pass', declaredRaw: 'pass', vendor: 'anthropic' }, { judge: 'B', verdict: 'pass', declaredRaw: 'pass', vendor: 'openai' }], ...base },
    want: true,
  },
  {
    name: '乙：一家 pass 一家 unclear → 签发且点名',
    arg: { verdicts: [{ judge: 'A', verdict: 'pass', declaredRaw: 'pass', vendor: 'anthropic' }, { judge: 'B', verdict: 'unclear', vendor: 'openai' }], ...base },
    want: true,
  },
  {
    name: '乙：全 unclear → 不签发',
    arg: { verdicts: [{ judge: 'A', verdict: 'unclear' }, { judge: 'B', verdict: 'unclear' }], ...base },
    want: false,
  },
  {
    name: '乙：一家 pass 一家 fail → 不签发',
    arg: { verdicts: [{ judge: 'A', verdict: 'pass', declaredRaw: 'pass' }, { judge: 'B', verdict: 'fail', declaredRaw: 'fail' }], ...base },
    want: false,
  },
  {
    name: '同厂商两家 pass → 不签发（vendors=1）',
    arg: { verdicts: [{ judge: 'A', verdict: 'pass', declaredRaw: 'pass' }, { judge: 'B', verdict: 'pass', declaredRaw: 'pass' }], ...base, vendors: 1 },
    want: false,
  },
  {
    name: '单路 pass + 有材料 → 签发',
    arg: { verdicts: [{ judge: 'single', verdict: 'pass', declaredRaw: 'pass' }], ...base, judgeCount: 1, vendors: 1 },
    want: true,
  },
  {
    name: '单路 pass + 没材料 → 不签发',
    arg: { verdicts: [{ judge: 'single', verdict: 'pass', declaredRaw: 'pass' }], ...base, judgeCount: 1, vendors: 1, materialCoverage: null },
    want: false,
  },
  {
    name: '单路 + 非字符串声明 → 不签发',
    arg: { verdicts: [{ judge: 'single', verdict: 'unclear', declaredRaw: ['pass'] }], ...base, judgeCount: 1, vendors: 1 },
    want: false,
  },
];
for (const c of casesD) {
  const r = decideReview(c.arg);
  const flag = r.issue === c.want ? 'PASS' : 'FAIL';
  if (flag === 'FAIL') bad++;
  console.log('  ' + flag + '  ' + c.name + (flag === 'FAIL' ? '  ← 实际 issue=' + r.issue : ''));
  if (flag === 'FAIL') console.log('        ' + r.note);
}

console.log('\n=== 四、逐家判定怎么被打包（模拟 perJudge → verdicts 这条链） ===');
// 这条链是本次修的 bug 所在：perJudge 必须把原始声明原样带出去。
function packPerJudge(a) {
  return {
    ...(typeof a.verdict === 'string' ? { verdict: a.verdict } : {}),
    ...(a.verdict === undefined ? {} : { declaredRaw: a.verdict }),
    ...(a.vendor ? { vendor: a.vendor } : {}),
  };
}
function packVerdicts(list) {
  return list.map(j => ({
    judge: j.judge,
    ...(j.vendor ? { vendor: j.vendor } : {}),
    verdict: verdictOf(j.conclusion, j.verdict),
    ...(j.declaredRaw === undefined && j.verdict === undefined ? {} : { declaredRaw: j.declaredRaw === undefined ? j.verdict : j.declaredRaw }),
  }));
}
const chained = [
  { judge: 'A', conclusion: '整体看过了', verdict: ['pass'], vendor: 'anthropic' },
  { judge: 'B', conclusion: '可以直接用', verdict: 'pass', vendor: 'openai' },
].map(x => ({ ...x, ...packPerJudge(x) }));
const chainedV = packVerdicts(chained);
const dChain = decideReview({ verdicts: chainedV, ...base });
const chainOk = dChain.issue === false;
if (!chainOk) bad++;
console.log('  ' + (chainOk ? 'PASS' : 'FAIL') + '  A 的数组声明穿过 perJudge → verdicts → decideReview 仍被拒');
console.log('        verdicts=' + JSON.stringify(chainedV));
console.log('        ' + dChain.note);

console.log('\n' + (bad === 0 ? '全部通过' : '失败 ' + bad + ' 条'));
process.exit(bad === 0 ? 0 : 1);

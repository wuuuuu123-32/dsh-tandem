// provider-state 的并发行为。
// 三家会审都点了这条：并行起多条 codex 时，状态文件是「读全量 → 改一个字段 → 写回」，
// 跨 await 没有锁 —— 后完成的那条用旧值覆盖先完成的，冷却会失效。
// 这里用真并发（多个 async 任务同时读写同一个 stateDir）复现，不靠读代码判断。
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import {
  readProviderState, writeProviderState, claimPortdanDay, releasePortdanDay,
  markPortdanStarted, tfCoolingDown, localDay,
} from '../lib/consult.js';

const root = 'D:/dsh/config/.tmp-state-race';
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

let bad = 0;
const report = (name, ok, detail) => {
  if (!ok) bad++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : '  ← ' + detail));
};

// ① 并发的字段写不该互相擦除：A 写 tfExhaustedAt、B 写 lastPortdanDay，
//    两个字段落在不同文件里，所以谁后写都不该把对方抹掉。
//    （旧版本用同一个 provider-state.json，A 会把 B 的字段用旧值覆盖 —— 那正是被点的问题。）
{
  await Promise.all([
    Promise.resolve().then(() => writeProviderState(root, { tfExhaustedAt: Date.now() })),
    Promise.resolve().then(() => writeProviderState(root, { lastPortdanDay: localDay() })),
  ]);
  const s = readProviderState(root);
  report('并发写两个字段 → 两个都在', !!s.tfExhaustedAt && !!s.lastPortdanDay,
    JSON.stringify(s));
}

// ② 冷却跨并发仍生效
{
  const s = readProviderState(root);
  report('tf 处于冷却期', tfCoolingDown(s) === true, 'tfExhaustedAt=' + s.tfExhaustedAt);
}

// ③ 清除冷却后不该被并发写复活
{
  writeProviderState(root, { tfExhaustedAt: null, tfExhaustedReason: null });
  await Promise.all([
    Promise.resolve().then(() => writeProviderState(root, { lastPortdanDay: localDay() })),
    Promise.resolve().then(() => writeProviderState(root, { tfExhaustedAt: null })),
  ]);
  const s = readProviderState(root);
  report('清除冷却后并发写不复活它', !tfCoolingDown(s), 'tfExhaustedAt=' + s.tfExhaustedAt);
}

// ④ 当日首选只能被认领一次（O_EXCL 原子性）
{
  rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
  const got = await Promise.all([1, 2, 3, 4].map(() => Promise.resolve().then(() => claimPortdanDay(root))));
  const n = got.filter(Boolean).length;
  report('4 路并发只认领成功 1 次', n === 1, '成功 ' + n + ' 次');
}

// ⑤ 归还资格：只在还没真跑过时才还
{
  const ok1 = claimPortdanDay(root, '2099-01-01');
  markPortdanStarted(root, '2099-01-01');
  const released = releasePortdanDay(root, '2099-01-01');
  report('已 started 的认领不可归还', ok1 === true && released === false, 'released=' + released);
}

rmSync(root, { recursive: true, force: true });
console.log(bad ? '\n有 ' + bad + ' 条不符' : '\n全部符合');
process.exit(bad ? 1 : 0);

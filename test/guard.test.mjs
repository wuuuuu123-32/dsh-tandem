/**
 * 会审闸的自测：不依赖 DSH 运行时，用假 ctx 把三个 hook 拉起来逐个触发。
 * 跑法：node test/guard.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { apply } from '../index.js';
import { createLedger, isTrackedPath, extractToolPaths } from '../lib/ledger.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  <<' + extra + '>>' : '')); }
};

const root = mkdtempSync(join(tmpdir(), 'guard-'));
const stateDir = join(root, 'state');
mkdirSync(stateDir, { recursive: true });
mkdirSync(join(root, 'src'), { recursive: true });
const A = join(root, 'src', 'a.js');
const B = join(root, 'src', 'b.js');
const C = join(root, 'src', 'c.md');
writeFileSync(A, 'a1'); writeFileSync(B, 'b1'); writeFileSync(C, 'c1');
writeFileSync(join(stateDir, 'reviews.jsonl'), '');
const later = (ms) => new Date(Date.now() + ms).toISOString();
const review = (id, at, paths, dir = stateDir) => {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'reviews.jsonl'), JSON.stringify({ reviewId: id, at, paths, fingerprint: 'x' }) + '\n');
};

console.log('— 纯函数 —');
ok(isTrackedPath(A) === true, '源码文件进账本');
ok(isTrackedPath(join(root, 'x')) === false, '无扩展名不进账本');
ok(isTrackedPath('src/a.js') === false, '相对路径不记账（避免猜错工作目录）');
ok(isTrackedPath(join(root, 'node_modules', 'x', 'a.js')) === false, 'node_modules 不记账');
ok(isTrackedPath(join(root, '_inbox.md')) === false, '_inbox.md 是笔记，不记账');
ok(extractToolPaths('write', { file_path: A }).length === 1, 'write 抽到 file_path');
ok(extractToolPaths('ops_batch', { operations: [{ path: A }, { from: B, to: C }] }).length === 3, 'ops_batch 抽到 operations');
ok(extractToolPaths('read', { file_path: A }).length === 0, '非写工具不抽路径');

console.log('— 账本判定 —');
{
  const led = createLedger({ stateDir, firstAt: 2, every: 4, persist: false });
  led.note(A, 's1'); led.note(B, 's1'); led.note(C, 's1');
  ok(led.summary().unreviewed === 3, '3 个未审');
  const r1 = led.reminder('s1');
  ok(typeof r1 === 'string' && r1.includes(A), '达到阈值注入提醒，且带文件路径');
  ok(led.reminder('s1') === null, '同一水位不重复提醒');
  const g1 = led.gate('s1');
  ok(typeof g1 === 'string' && g1.includes('present'), 'present 闸给出拦截文案');
  ok(led.gate('s1') === null, '同一批未审改动只拦一次');
  review('rv-1', later(60000), [A]);
  ok(led.summary().unreviewed === 2, 'A 被「晚于改动」的会审覆盖后清账');
  ok(led.gate('s2') !== null, '另一个会话独立记账/独立拦');
  ok(led.reminder('s1') === null, '2 个未审仍未到下一次水位');
}
console.log('— 会审时间必须晚于改动 —');
{
  const led = createLedger({ stateDir, firstAt: 1, every: 1, persist: false });
  led.note(B, 's1');
  ok(led.summary().unreviewed >= 1, '旧会审不能清掉本次改动（B 的会审记录在改动之前）');
}
console.log('— 改动后再审才算数 —');
{
  // 会审记录的时间戳必须单调递增（真实写入永远是），这里按 now+120s 排在前一条之后。
  const led = createLedger({ stateDir, firstAt: 99, every: 99, persist: false });
  const B2 = join(root, 'src', 'b2.js');
  writeFileSync(B2, 'b2-1');
  led.note(B2, 's1');
  review('rv-2', later(120000), [B2]);
  ok(led.summary().unreviewed === 0, '先改后审：改动时间早于会审时间 → 已覆盖');
  const t = new Date(Date.now() + 180000);
  utimesSync(B2, t, t);   // 会审之后文件又被写过（mtime 越过会审时间）
  ok(led.summary().unreviewed === 1, '会审之后文件再被写入 → 重新变未审');
}
console.log('— 删除的文件不再要求会审 —');
{
  const led = createLedger({ stateDir, firstAt: 99, every: 99, persist: false });
  const D = join(root, 'src', 'd.js');
  writeFileSync(D, 'd1');
  led.note(D, 's1');
  ok(led.summary().unreviewed === 1, 'D 未审');
  rmSync(D);
  const realNow = Date.now;
  Date.now = () => realNow() + 20000;   // 模拟 20 秒后
  ok(led.summary().unreviewed === 0, '文件被删掉后从账本摘除');
  Date.now = realNow;
}

console.log('— 插件挂钩（假 ctx 触发三个 hook）—');
{
  // 独立 stateDir：账本会落盘，共用目录会让这一块捡到前面块留下的未审改动。
  const stateDir2 = join(root, 'state2');
  mkdirSync(stateDir2, { recursive: true });
  const registered = [];
  // 一个事件名可以挂多个钩子（会审闸 + 求援都挂 tools/post-execute）—— 用数组存，
  // 否则后注册者会把先注册的覆盖掉，测出来的是假象。
  const handlers = new Map();
  const ctx = {
    tools: { register: (tool) => { registered.push(tool); return () => {}; } },
    on: (name, fn, opts) => {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push({ fn, opts });
      return () => {};
    },
  };
  const hookAt = (name, i = 0) => (handlers.get(name) || [])[i]?.fn;
  const hookOpts = (name, i = 0) => (handlers.get(name) || [])[i]?.opts;
  // 多个同名钩子串成 waterfall：先注册的在外层，最后看到下游结果（与 DSH 的叠加顺序一致）。
  const chain = (name, exec, result = { kind: 'ok' }) => {
    const list = handlers.get(name) || [];
    let next = () => Promise.resolve(result);
    for (let i = list.length - 1; i >= 0; i--) {
      const fn = list[i].fn;
      const inner = next;
      next = () => fn(exec, {}, inner);
    }
    return next();
  };
  const dispose = apply(ctx, { stateDir: stateDir2, configFile: join(root, 'no-such.json'), reviewGuard: true, reviewGuardFirst: 2, reviewGuardEvery: 4 });
  ok(typeof dispose === 'function', 'apply 返回 dispose');
  ok(registered.length === 5, '注册了 5 个工具', String(registered.length));
  ok(handlers.has('fs/write-intent') && hookOpts('fs/write-intent')?.prepend === true, 'fs/write-intent 以 prepend 注册');
  ok(handlers.has('fs/edit-intent'), 'fs/edit-intent 已注册');
  ok(handlers.has('tools/post-execute') && handlers.has('tools/pre-execute'), '工具前后钩子已注册');

  const session = { agent: { session: 'sess-1' } };
  const E1 = join(root, 'src', 'e1.js');
  const E2 = join(root, 'src', 'e2.js');
  writeFileSync(E1, 'x'); writeFileSync(E2, 'y');
  const intent = hookAt('fs/write-intent');
  let nextCalled = 0;
  const nextFn = () => { nextCalled++; return Promise.resolve({ kind: 'createIfAbsent' }); };
  const intentResult = await intent({ targetKey: 'k', displayPath: E1 }, session, nextFn);
  ok(nextCalled === 1 && intentResult.kind === 'createIfAbsent', 'fs 意图放行并原样返回下游决策');
  await intent({ targetKey: 'k', displayPath: E2 }, session, nextFn);

  const post = (exec, result) => chain('tools/post-execute', exec, result);
  const downstream = await post({ name: 'write', arguments: {}, agent: { session: 'sess-1' } });
  const injected = downstream.additionalContexts?.[0];
  ok(!!injected && injected.role === 'user', '提醒以 user 消息注入');
  ok(injected?.source?.kind === 'dsh-tandem' && injected.source.form === 'notice', 'source.kind/form 正确（不会被当成真人消息）');
  ok(typeof injected?.id === 'string' && injected.id.length > 0, '消息带 id');
  ok(injected?.content?.[0]?.text?.includes('E1'.replace('E1', 'e1.js')) || injected?.content?.[0]?.text?.includes('e1.js'), '提醒里点了名');

  const pre = hookAt('tools/pre-execute');
  const deny = await pre({ name: 'present', arguments: {}, agent: { session: 'sess-1' } }, () => Promise.resolve({ kind: 'allow' }));
  ok(deny.kind === 'deny' && typeof deny.reason === 'string' && deny.reason.includes('present'), 'present 首次被拦');
  ok(deny.info?.code === 'REVIEW_REQUIRED', '拦截带机器可读 code');
  const again = await pre({ name: 'present', arguments: {}, agent: { session: 'sess-1' } }, () => Promise.resolve({ kind: 'allow' }));
  ok(again.kind === 'allow', '同批第二次放行（不死循环）');
  const other = await pre({ name: 'read', arguments: { file_path: A }, agent: { session: 'sess-1' } }, () => Promise.resolve({ kind: 'allow' }));
  ok(other.kind === 'allow', '其它工具完全不受影响');

  // 放行不能是沉默的：第二次 present 之后必须往对话里说明「这次交付含未审改动」
  const presentPost = await post({ name: 'present', arguments: {}, agent: { session: 'sess-1' } });
  const presentNote = presentPost.additionalContexts?.[0]?.content?.[0]?.text || '';
  ok(presentNote.includes('未经会审'), 'present 放行时明示「含未审改动」', presentNote.slice(0, 60));
  ok(presentNote.includes('e1.js') || presentNote.includes('E1'), '明示里带了具体路径');

  // 会审覆盖 E1/E2 之后，闸自动解除
  review('rv-3', later(300000), [join(root, 'src')], stateDir2);
  const post2 = await post({ name: 'write', arguments: {}, agent: { session: 'sess-1' } });
  ok(!post2.additionalContexts, '覆盖之后不再提醒');
  const statusTool = registered.find(t => t.name === 'tandem_status');
  const status = await statusTool.execute({});
  ok(status.reviewGuard && status.reviewGuard.enabled === true, 'tandem_status 暴露 reviewGuard');
  ok(status.reviewGuard.unreviewed === 0, '状态下未审为 0', JSON.stringify(status.reviewGuard));
  dispose();
}
console.log('— state 目录：只排除自己的账本目录 —');
{
  // 会审反例：一刀切排除所有 state 目录 = 改动落在这种目录下就不记账，直接绕过。
  const stateDir5 = join(root, 'state5');
  const inState = join(root, 'proj', 'state', 'config.js');
  const ownLedger = join(stateDir5, 'probe.js');
  mkdirSync(join(root, 'proj', 'state'), { recursive: true });
  writeFileSync(inState, 'x');
  ok(isTrackedPath(inState) === true, '别的 state 目录里的源码仍算可跟踪');
  const led = createLedger({ stateDir: stateDir5, firstAt: 1, every: 1 });
  ok(led.note(inState, 's1') === true, '别的 state 目录里的改动照常记账');
  ok(led.note(ownLedger, 's1') === false, '账本自己所在的目录不记账（不会自己记自己）');

  // 会审反例：stateDir 末尾带分隔符（极端情况是盘根 D:\）时，拼出的前缀会带两个分隔符而永远匹配不上
  const led2 = createLedger({ stateDir: stateDir5 + sep, firstAt: 1, every: 1 });
  ok(led2.note(ownLedger, 's1') === false, 'stateDir 带尾部分隔符时仍正确排除自己的目录');
}

console.log('— 账本落盘：DSH 重启不洗白 —');
{
  const stateDir3 = join(root, 'state3');
  const F1 = join(root, 'src', 'f1.js');
  writeFileSync(F1, 'f1');
  const led1 = createLedger({ stateDir: stateDir3, firstAt: 1, every: 1 });
  led1.note(F1, 's1');
  ok(led1.summary().unreviewed === 1, '记账后未审 1');
  const led2 = createLedger({ stateDir: stateDir3, firstAt: 1, every: 1 });   // 模拟 DSH 重启
  ok(led2.summary().tracked === 1, '重启后账本恢复（不再清零）', JSON.stringify(led2.summary()));
  ok(led2.summary().unreviewed === 1, '重启前未审的改动，重启后仍然未审');
  ok(led2.gate('s9') !== null, '重启后 present 闸照样拦得住');
  review('rv-4', later(60000), [F1], stateDir3);
  ok(led2.summary().unreviewed === 0, '会审覆盖后清账');
  const led3 = createLedger({ stateDir: stateDir3, firstAt: 1, every: 1 });
  ok(led3.summary().unreviewed === 0, '重启后仍认那次会审');
}

console.log('— 交付留痕：放行不沉默 —');
{
  const stateDir4 = join(root, 'state4');
  const G1 = join(root, 'src', 'g1.js');
  writeFileSync(G1, 'g1');
  const led = createLedger({ stateDir: stateDir4, firstAt: 1, every: 1 });
  led.note(G1, 's1');
  ok(led.gate('s1') !== null, 'present 首次被拦');
  ok(led.gate('s1') === null, '同批第二次放行');
  const warn = led.deliveryWarning('s1', 'present');
  ok(typeof warn === 'string' && warn.includes('未经会审'), '放行时给出留痕文案');
  const rec = led.lastDelivery();
  ok(rec && rec.count === 1, '交付账本记了一条');
  ok(rec && rec.files[0] === G1, '账本里落了具体路径');
  ok(led.summary().lastDelivery && led.summary().lastDelivery.count === 1, 'tandem_status 能读到交付账');
  const led2 = createLedger({ stateDir: stateDir4, firstAt: 1, every: 1 });
  ok(led2.lastDelivery() && led2.lastDelivery().count === 1, '重启后交付账仍可查');
  review('rv-5', later(60000), [G1], stateDir4);
  ok(led.deliveryWarning('s1', 'present') === null, '没有未审改动时不落账');
}

rmSync(root, { recursive: true, force: true });
console.log('');
console.log(fail === 0 ? 'ALL PASS (' + pass + ')' : pass + ' pass / ' + fail + ' FAIL');
process.exit(fail === 0 ? 0 : 1);

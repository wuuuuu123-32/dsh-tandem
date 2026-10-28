// 注册冒烟：apply 在 mock ctx 上能否把 5 个工具都注册成功，且关键 schema 没退化。
// 为什么不能只查 tandem_consult 存在：schema 编译失败会被 register 吞掉，
// 少一个工具、少一个字段都不会报错，只会让调用方在某次实际使用时才炸。
import { apply } from '../index.js';

const fail = [];
const registered = [];
const hooks = [];
// ctx.on 必须 mock：会审闸与自动求援都靠 ctx.on 注册 hook，
// 缺了它 apply 里那两段会各自抛错并被 try/catch 吞掉 —— 工具还在、闸却没了，测不出来。
const ctx = {
  tools: { register(t) { registered.push(t); return () => {}; } },
  on(event, fn, opts) { hooks.push({ event, fn, opts: opts || null }); return () => {}; },
};
apply(ctx, { codexCommand: 'codex', stateDir: 'C:/Users/123/.dsh/tandem-state' });

const EXPECT = ['tandem_status', 'tandem_delegate', 'tandem_consult', 'tandem_check', 'tandem_reject'];
const names = registered.map(t => t.name);
for (const n of EXPECT) if (!names.includes(n)) fail.push('工具没注册：' + n);
if (registered.length !== EXPECT.length) fail.push('注册数 ' + registered.length + '，期望 ' + EXPECT.length + '（多出来的：' + names.filter(n => !EXPECT.includes(n)).join(',') + '）');

for (const t of registered) {
  if (!t.output || !t.output.schema) fail.push(t.name + ' 缺 output.schema');
  if (!t.parameters || typeof t.parameters !== 'object') fail.push(t.name + ' 缺 parameters');
  if (typeof t.execute !== 'function') fail.push(t.name + ' 缺 execute');
}

const consult = registered.find(t => t.name === 'tandem_consult');
if (consult) {
  const props = consult.output.schema.properties || {};
  for (const k of ['ok', 'provider', 'attempts', 'failoverFrom', 'attemptsLog', 'stoppedBy', 'budgetNote', 'dual']) {
    if (!props[k]) fail.push('consult 返回字段缺：' + k);
  }
  const items = props.attemptsLog && props.attemptsLog.items && props.attemptsLog.items.properties;
  if (!items) fail.push('consult.attemptsLog.items 没有 properties');
  else for (const k of ['provider', 'ok', 'ms', 'timeoutMs', 'reason', 'started']) {
    if (!items[k]) fail.push('consult.attemptsLog.items 缺字段：' + k);
  }
  const dualItems = props.dual && props.dual.items && props.dual.items.properties;
  if (!dualItems) fail.push('consult.dual.items 没有 properties');
  else {
    for (const k of ['provider', 'ok', 'attemptsLog', 'failoverFrom']) {
      if (!dualItems[k]) fail.push('consult.dual.items 缺字段：' + k);
    }
    const di = dualItems.attemptsLog && dualItems.attemptsLog.items && dualItems.attemptsLog.items.properties;
    // 之前写成 `if (di && !di.started)`：整个 items 缺失时静默通过，等于没测。
    if (!di) fail.push('consult.dual.items.attemptsLog.items 没有 properties');
    else if (!di.started) fail.push('consult.dual.items.attemptsLog.items 缺 started');
  }
  // 注册时参数已被编译成标准 JSON Schema（{type, properties, required}），不是插件源里的平铺对象。
  const pprops = (consult.parameters && consult.parameters.properties) || {};
  const preq = (consult.parameters && consult.parameters.required) || [];
  for (const k of ['mode', 'question', 'provider', 'failover', 'deadlineMs', 'paths']) {
    if (!pprops[k]) fail.push('consult 入参缺：' + k);
  }
  for (const k of ['mode', 'question']) {
    if (!preq.includes(k)) fail.push('consult 必填入参没进 required：' + k);
  }
}

// hook 齐全才算「闸真的挂上了」：少了 fs intent 就记不到改动，少了 post-execute 就提醒不了，
// 少了 pre-execute 就拦不住带未审改动的交付。
const hookEvents = hooks.map(h => h.event);
for (const ev of ['fs/write-intent', 'fs/edit-intent', 'tools/post-execute', 'tools/pre-execute']) {
  if (!hookEvents.includes(ev)) fail.push('hook 没注册：' + ev);
}
// 光有事件名不够：传进去的不是函数，注册了也等于没挂。
for (const h of hooks) {
  if (typeof h.fn !== 'function') fail.push(h.event + ' 的回调不是函数（注册了也没用）');
}
const intentHook = hooks.find(h => h.event === 'fs/write-intent');
if (intentHook && !(intentHook.opts && intentHook.opts.prepend)) {
  fail.push('fs/write-intent 没带 prepend：会排在 dsh-fs-observation-policy 后面，永远轮不到');
}
if (hookEvents.filter(e => e === 'tools/post-execute').length < 2) {
  fail.push('tools/post-execute 只注册了 ' + hookEvents.filter(e => e === 'tools/post-execute').length + ' 个（会审提醒与自动求援各需一个）');
}

console.log('注册数:', registered.length, '→', names.join(', '));
console.log('hooks:', hooks.map(h => h.event + (h.opts && h.opts.prepend ? '(prepend)' : '')).join(', '));
if (fail.length) {
  console.log('SMOKE FAIL:');
  for (const f of fail) console.log(' - ' + f);
  process.exit(1);
}
console.log('SMOKE OK: 5 个工具、' + hooks.length + ' 个 hook、关键 schema 字段齐全');

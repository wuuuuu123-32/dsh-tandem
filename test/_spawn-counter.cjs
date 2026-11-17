// 子进程调用计数器（给 verify-gates-live.mjs 用）。
//
// 为什么需要它：会审第四轮 portdan 判 fail，原话是
//   「若某条绕过门禁的路径直接调用 codexCommand 或其他执行器、没有经过 runConsult，
//    超限测试仍会看到目录数 3 → 3、ms 为 0，却无法发现请求已发出。」
// 只盯「consult-* 临时目录」确实有盲区 —— 那是 runConsult 的副作用，换个函数直接 spawn 就看不见了。
//
// 做法：测试把 codexCommand 指向 process.execPath（node 自己），再通过 NODE_OPTIONS=--require 本文件。
//   profileEnv() 全量透传 process.env（lib/consult.js: `if (!profile || !profile.envKey) return process.env;`
//   否则 `{...process.env}`），所以子进程一启动就会先执行这里、追加一行 PID。
//   无论哪个函数、哪条分支 spawn 出来的，只要它是 node 就一定会被记到 —— 这就是「所有外部执行入口」的观测点。
//
// 本文件在子进程里跑，进程会紧接着因为参数不是有效脚本而报错退出，那一行记录是我们唯一要的东西。
try {
  const f = process.env.TANDEM_SPAWN_LOG;
  if (f) require('node:fs').appendFileSync(f, process.pid + '\n');
} catch {
  // 计数失败不影响被测代码；测试自己会断言「文件存在且行数符合预期」，失败会在那里暴露。
}

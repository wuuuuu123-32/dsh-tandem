// failover 端到端自测：正常 / 切换 / 不该切换 / 钉死 provider
import { runConsult, CONSULT_PROVIDERS } from '../lib/consult.js';
const CODEX = 'C:/Users/123/AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';
const stateDir = 'C:/Users/123/.dsh/tandem-state/_failover-test';
const cfg = { codexCommand: CODEX, model: 'gpt-6.1-sol', stateDir, workRoots: ['D:/dsh/work'], maxParallel: 3, taskTimeoutMs: 900000 };
const Q = '这是自动化测试用的自包含问题：判断这句话是否有边界缺陷——「所有请求都应在 30 秒内返回，否则算失败」。只做判断，不写文件。';
const brief = (tag, r) => console.log(tag, JSON.stringify({ ok: r.ok, reason: r.reason, provider: r.provider, failoverFrom: r.failoverFrom, attempts: r.attempts, ms: r.ms, log: (r.attemptsLog || []).map(a => ({ p: a.provider, ok: a.ok, ms: a.ms, r: a.reason })) }));

const orig = CONSULT_PROVIDERS.portdan.model;
try {
  brief('T1_normal', await runConsult({ mode: 'review', question: Q, config: cfg }));
  CONSULT_PROVIDERS.portdan.model = 'gpt-6.1-sol-nope-zz';
  brief('T2_failover', await runConsult({ mode: 'review', question: Q, config: cfg }));
  brief('T4_pinned', await runConsult({ mode: 'review', question: Q, config: cfg, provider: 'portdan' }));
  CONSULT_PROVIDERS.portdan.model = orig;
  brief('T3_spawn', await runConsult({ mode: 'review', question: Q, config: { ...cfg, codexCommand: 'Z:/no-such-codex.exe' } }));
} finally { CONSULT_PROVIDERS.portdan.model = orig; }

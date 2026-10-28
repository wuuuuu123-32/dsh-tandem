// failover 边界自测：切换标记、钉死、failover:false、显式 provider 强制切换
// 用 cmd.exe 当「假 codex」：它见到 exec 这种参数只会报错退出 1，几百毫秒就结束 ——
// 失败快，才能在几秒内把「主端两败 + 备用也败」这类组合全跑完（真上游一次要 20 到 50 秒）。
import { runConsult } from '../lib/consult.js';

const stateDir = 'C:/Users/123/.dsh/tandem-state/_failover-edge';
const cfg = {
  codexCommand: 'C:/Windows/System32/cmd.exe',
  model: 'gpt-6.1-sol',
  stateDir,
  workRoots: ['D:/dsh/work'],
  maxParallel: 3,
  taskTimeoutMs: 900000,
};
const Q = '这是自动化测试用的自包含问题：判断这句话是否有边界缺陷——「所有请求都应在 30 秒内返回，否则算失败」。只做判断，不写文件。';
const brief = (tag, r, expect) => {
  const log = (r.attemptsLog || []).map(a => ({ p: a.provider, ok: a.ok, r: a.reason }));
  const got = { ok: r.ok, reason: r.reason, failoverFrom: r.failoverFrom, attempts: r.attempts, stoppedBy: r.stoppedBy, log };
  const bad = [];
  if (expect.attempts !== undefined && got.attempts !== expect.attempts) bad.push('attempts 应为 ' + expect.attempts);
  if (expect.failoverFrom !== undefined && (got.failoverFrom || null) !== expect.failoverFrom) bad.push('failoverFrom 应为 ' + String(expect.failoverFrom));
  if (expect.ok !== undefined && got.ok !== expect.ok) bad.push('ok 应为 ' + expect.ok);
  console.log((bad.length ? 'FAIL ' : 'ok   ') + tag + ' ' + JSON.stringify(got) + (bad.length ? '  << ' + bad.join('; ') : ''));
  return bad.length === 0;
};

const out = [];
try {
  // E1：默认（不指定 provider、failover 默认开）→ 主端两次 + 备用一次，且要记下让位者
  out.push(brief('E1_default_three_attempts', await runConsult({ mode: 'review', question: Q, config: cfg }), { attempts: 3, failoverFrom: 'portdan', ok: false }));
  // E2：failover:false → 不许碰备用
  out.push(brief('E2_failover_off', await runConsult({ mode: 'review', question: Q, config: cfg, failover: false }), { attempts: 2, failoverFrom: null, ok: false }));
  // E3：显式 provider 视为钉死
  out.push(brief('E3_pinned', await runConsult({ mode: 'review', question: Q, config: cfg, provider: 'portdan' }), { attempts: 2, failoverFrom: null, ok: false }));
  // E4：显式 provider + failover:true → 说明里承诺的「强制打开」必须真的打开
  out.push(brief('E4_pinned_forced', await runConsult({ mode: 'review', question: Q, config: cfg, provider: 'portdan', failover: true }), { attempts: 3, failoverFrom: 'portdan', ok: false }));
  // E5：显式 aisz + failover:true → 让位者应当记 aisz，而不是写死 portdan
  out.push(brief('E5_pinned_aisz_forced', await runConsult({ mode: 'review', question: Q, config: cfg, provider: 'aisz', failover: true }), { attempts: 3, failoverFrom: 'aisz', ok: false }));
} catch (e) {
  console.log('FAIL 抛出异常 ' + e.message);
  out.push(false);
}
console.log(out.every(Boolean) ? 'EDGE ALL PASS' : 'EDGE HAS FAILURES');

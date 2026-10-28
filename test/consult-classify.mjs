#!/usr/bin/env node
/**
 * consult 失败分类的回归测试（不联网、不调 Codex，纯夹具）。
 *
 * 为什么要有它：2026-10-17 那次会审失败只报了「codex 退出码 1」，
 * 真实原因（上游内容策略拦截）躺在日志里，被当成「没有意见」跳过了。
 * 这里把每种失败钉成断言，改了 classifyFailure 就会立刻炸。
 */
import { classifyFailure, extractFailure, validAnswer } from '../lib/consult.js';

const cases = [];
const t = (name, actual, want) => cases.push({ name, actual, want });

// 事件流夹具
const line = (obj) => JSON.stringify(obj);
const policyLog = [
  line({ type: 'thread.started', thread_id: 'x' }),
  line({ type: 'turn.started' }),
  line({ type: 'turn.failed', error: { message: 'Invalid prompt: your prompt was flagged as potentially violating our usage policy.' } }),
].join('\n');
const authLog = line({ type: 'turn.failed', error: { message: '401 Unauthorized: invalid api key' } });
const rateLog = line({ type: 'turn.failed', error: { message: '429 Too Many Requests' } });
const modelLog = line({ type: 'turn.failed', error: { message: 'Model "gpt-x" is not supported' } });
const emptyLog = line({ type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } });
const okLog = [
  line({ type: 'item.completed', item: { type: 'agent_message', text: '{"conclusion":"x","evidence":["a"],"counterexamples":["b"],"verification":"c"}' } }),
  line({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } }),
].join('\n');

t('策略拦截 → policy_blocked', classifyFailure({ code: 1, logText: policyLog }), 'policy_blocked');
t('凭据错误 → auth_failed', classifyFailure({ code: 1, logText: authLog }), 'auth_failed');
t('限流 → rate_limited', classifyFailure({ code: 1, logText: rateLog }), 'rate_limited');
t('模型名错 → model_not_found', classifyFailure({ code: 1, logText: modelLog }), 'model_not_found');
t('空转（0 token、无回答）→ empty_response', classifyFailure({ code: 1, logText: emptyLog }), 'empty_response');
t('超时优先 → timeout', classifyFailure({ code: 1, logText: policyLog, timedOut: true }), 'timeout');
t('spawn 失败 → spawn_failed', classifyFailure({ code: null, logText: '', error: '启动失败：ENOENT' }), 'spawn_failed');
t('不可识别 → unknown', classifyFailure({ code: 1, logText: line({ type: 'turn.failed', error: { message: 'boom' } }) }), 'unknown');

// 第二组：各家上游对同一类失败的措辞不同。只认 portdan 那一种，别家的拦截/限流/模型错
// 会全掉进 unknown —— 而 unknown 既能重试又能切换，等于把「内容被拦」当成「上游抖动」处理。
const fail = (m) => line({ type: 'turn.failed', error: { message: m } });
t('OpenAI 风格的安全拦截 → policy_blocked', classifyFailure({ code: 1, logText: fail('Your request was rejected as a result of our safety system.') }), 'policy_blocked');
t('内容过滤措辞 → policy_blocked', classifyFailure({ code: 1, logText: fail('Output blocked: content filtering policy.') }), 'policy_blocked');
t('invalid_prompt 错误码 → policy_blocked', classifyFailure({ code: 1, logText: fail('400 invalid_prompt: request rejected') }), 'policy_blocked');
t('Incorrect API key → auth_failed', classifyFailure({ code: 1, logText: fail('Incorrect API key provided: sk-xxx') }), 'auth_failed');
t('余额不足 → auth_failed（凭据没错但这家用不了）', classifyFailure({ code: 1, logText: fail('403: {"message":"insufficient balance","type":"billing_error"}') }), 'auth_failed');
t('并发限流措辞 → rate_limited', classifyFailure({ code: 1, logText: fail('gateway_concurrency_limit reached') }), 'rate_limited');
t('分组里没有该模型 → model_not_found', classifyFailure({ code: 1, logText: fail('{"code":"model_not_found","message":"Model gpt-x is not available for this group"}') }), 'model_not_found');
t('模型不存在（英文变体）→ model_not_found', classifyFailure({ code: 1, logText: fail('The model gpt-x does not exist') }), 'model_not_found');

t('能取出 turn.failed 原文', extractFailure(policyLog).includes('flagged'), true);
t('正常日志不误判为失败原文', extractFailure(okLog), '');

t('四段齐全 → 有效', validAnswer({ conclusion: 'c', evidence: ['e'], counterexamples: ['x'], verification: 'v' }), true);
t('缺验证方式 → 无效', validAnswer({ conclusion: 'c', evidence: ['e'], counterexamples: ['x'] }), false);
t('证据为空数组 → 无效', validAnswer({ conclusion: 'c', evidence: [], counterexamples: ['x'], verification: 'v' }), false);
t('结论是空串 → 无效', validAnswer({ conclusion: '  ', evidence: ['e'], counterexamples: ['x'], verification: 'v' }), false);

let fails = 0;
for (const c of cases) {
  const ok = c.actual === c.want;
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + c.name + (ok ? '' : '  期望=' + JSON.stringify(c.want) + ' 实际=' + JSON.stringify(c.actual)));
}
console.log((cases.length - fails) + '/' + cases.length);
process.exit(fails ? 1 : 0);

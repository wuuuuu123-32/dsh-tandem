/**
 * 自动求援（auto rescue）——「转了很久就主动问一句」。
 *
 * 由来：2026-10-20 的 APK 逆向会话（145 次工具调用 / 57 分钟）里，agent 在没有任何人提醒时
 * 从没想过求援；用户在第 137 次调用时手动说「遇到反复思考解决不了的记得联合 gpt 解决」，
 * 它才去问 —— 那时已经烧掉 40 分钟。而同一份轨迹里显式失败只有 5 次、且全是孤立的
 * （连续失败段长度恒为 1），同一条命令重复最多 6 次 ——
 * 所以任何「按重复次数 / 报错次数」写的判据在那个样本上都不会响。
 *
 * 因此这里不做「判定卡住」，只做「到点问一句」，判断交给外部模型：
 *   - 判据宽、可反复触发（15 次调用 / 10 分钟无用户消息 / 冷却 20 分钟，均可配）
 *   - 材料是真实轨迹（命令首行 + 结果首行 + 异常标记 + 用户目标），不是摘要
 *   - 结论在**下一次**工具调用时注入，明写「自动触发、不是用户说的、可以忽略」
 *   - 拿不到结论也必须注入（高峰时段 Codex 会 empty_response / 超时，静默等于没做）
 *
 * 状态每次从 session.events 现场重算，插件只留「上次触发时间」——
 * 不缓存轨迹，也就不存在「插件中途才装上、前面的轨迹采不到」「DSH 重启后账本丢失」的问题。
 */

import { runConsult } from './consult.js';

/** 异常输出特征。看的是输出正文，不是退出码 —— 退出码在很多工具里恒为 0。 */
const ANOMALY_PATTERNS = [
  [/\[exit code: [1-9]\d*\]/, 'exit'], // 非零退出
  [/Traceback \(most recent call last\)/, 'traceback'],
  [/\[timed out after/, 'timeout'],
  [/\[sandbox: file access denied/, 'sandbox'],
  [/Fatal signal|SIGSEGV|\bpanic:/, 'fatal'],
  [/command not found|No such file or directory/i, 'notfound'],
  [/\bfailed to\b|\bFAILED\b/, 'failed'],
];

/** 真实用户消息的 source.kind。其它 kind（time-context / runtime-context / dsh-tandem / skill-catalog…）都不是用户开口。 */
const USER_KIND = 'user';

/** 轨迹最多带多少步给外部模型。39 步的「只有命令」版被判 UNDECIDABLE，30 步带结果够用。 */
const TRACE_STEPS = 30;

export function anomalyOf(text) {
  if (!text) return '';
  for (const [re, tag] of ANOMALY_PATTERNS) if (re.test(text)) return tag;
  return '';
}

/** 从消息 content 里取出文本（content 是块数组，不是字符串）。 */
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      out += block.text;
      if (out.length > 8000) break;
    }
  }
  return out;
}

/** 事件时间戳统一成 epoch 毫秒。 */
export function tsOf(ev) {
  const t = ev && (ev.time ?? ev.createdAt);
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  if (typeof t === 'string') {
    const n = Date.parse(t);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** 工具参数可能是 JSON 字符串（tool/call 事件里就是字符串）。 */
function argsOf(raw) {
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? raw : {};
}

/** 一次调用的「一句话」：优先命令，其次路径 / 查询词 / 提示词。 */
function headOf(name, args) {
  const v =
    args.command ?? args.file_path ?? args.path ?? args.pattern ?? args.query ??
    args.description ?? args.prompt ?? args.name ?? '';
  const s = typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v);
  const first = s.split('\n')[0].trim();
  return first.length > 160 ? first.slice(0, 160) + '…' : first;
}

/** 结果首行：压掉空行与行首空白，取一行。 */
function outHeadOf(text, max = 220) {
  if (!text) return '';
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (s === '') continue;
    return s.length > max ? s.slice(0, max) + '…' : s;
  }
  return '';
}

/**
 * 扫最近的会话事件，出统计量 + 轨迹。
 *
 * 三处刻意的写法（都被会审挑过一次）：
 *   1. 找「最后一条真实用户消息」不设小窗口 —— 用 600 条做窗口，长 turn 里用户消息一旦滑出窗口，
 *      调用数就只按窗口内算，可能永远够不到阈值（漏报），用户目标也会丢。
 *   2. turnOpen 反向扫到**第一条** turn 边界就停，不设固定窗口 —— 否则 turn/start 落在窗口外、
 *      又没有 turn/end 的长 turn 会被判成「已结束」，那是最该求援的时候反而不问。
 *   3. 只有 source.kind === 'user' 才算用户开口（实测取值还有 time-context / runtime-context /
 *      dsh-tandem / skill-catalog / agent-instructions / dsh-mnemon / user-approval，都不是）。
 *      缺 kind 的消息一律不当用户消息 —— 宁可把 silent 算成无限（更早问一句），也不要被系统注入
 *      反复重置计时、把真正卡住的会话压住。
 *
 * @param events - session.events（数组）
 * @param sinceUserOnly - true = 调用数与轨迹只从最后一条真实用户消息之后算
 */
export function survey(events, sinceUserOnly = true) {
  const empty = { callsSinceUser: 0, callsTotal: 0, lastUserAt: 0, anomMax: 0, anomCount: 0, trace: [], turnOpen: false, goal: '', truncated: false };
  if (!Array.isArray(events) || events.length === 0) return empty;

  const n = events.length;

  // 1) 先定位最后一条真实用户消息（最多回看 5000 条 —— 长 turn 的常态，不是病态）
  const USER_SCAN = 5000;
  let lastUserIdx = -1;
  let lastUserAt = 0;
  let goal = '';
  for (let i = n - 1; i >= 0 && i >= n - USER_SCAN; i--) {
    const e = events[i];
    if (e?.type !== 'user/message') continue;
    const kind = e.data?.source?.kind ?? e.source?.kind;
    if (kind !== USER_KIND) continue;
    lastUserIdx = i;
    lastUserAt = tsOf(e);
    const text = textOf(e.data?.content).trim();
    if (text) goal = text;
    break;
  }

  // 2) 统计窗口：以最后用户消息为下界，但不超过 5000 条；没有用户消息时只看最近 600 条。
  // sinceUserOnly=false 只用于排查/统计（全量），生产路径永远是 true。
  const lower = lastUserIdx >= 0 ? lastUserIdx : n - 600;
  const start = sinceUserOnly ? Math.max(0, n - 5000, lower) : Math.max(0, n - 20000);
  const truncated = start > 0 && start > lastUserIdx && lastUserIdx >= 0;

  const results = new Map();
  const calls = [];
  for (let i = start; i < n; i++) {
    const e = events[i];
    if (!e || typeof e.type !== 'string') continue;
    if (e.type === 'tool/call') {
      calls.push({ id: e.data?.callId, at: i, name: e.data?.name, args: argsOf(e.data?.arguments) });
    } else if (e.type === 'tool/result') {
      const id = e.data?.toolCallId ?? e.data?.message?.source?.callId;
      if (id) results.set(id, textOf(e.data?.message?.content));
    }
  }

  const after = sinceUserOnly && lastUserIdx >= 0 ? calls.filter((c) => c.at > lastUserIdx) : calls;

  let run = 0;
  let anomCount = 0;
  const items = [];
  for (const c of after) {
    const out = results.get(c.id) || '';
    const anom = anomalyOf(out);
    if (anom) {
      run += 1;
      anomCount += 1;
    } else {
      run = 0;
    }
    items.push({ name: c.name || '?', head: headOf(c.name, c.args), out: outHeadOf(out), anom, run });
  }
  const anomMax = items.reduce((m, x) => Math.max(m, x.run), 0);

  // 3) 最后一个 turn 是否还开着：反向扫到第一条 turn 边界就停，不吃窗口限制
  let turnOpen = false;
  const TURN_SCAN = 20000;
  for (let i = n - 1; i >= 0 && i >= n - TURN_SCAN; i--) {
    const t = events[i]?.type;
    if (t === 'turn/end') {
      turnOpen = false;
      break;
    }
    if (t === 'turn/start') {
      turnOpen = true;
      break;
    }
  }

  // 找不到用户消息（在回看窗口之外，或事件被裁过）：拿窗口里最早一条的时间当沉默下界。
  // 不能留 0 —— shouldFire 会把 0 当「无限久」，那会把「刚说过话、但消息已滑出窗口」误判成沉默。
  if (!lastUserAt && events.length > 0) lastUserAt = tsOf(events[0]) || 0;

  return {
    callsSinceUser: after.length,
    callsTotal: calls.length,
    lastUserAt,
    anomMax,
    anomCount,
    trace: items.slice(-TRACE_STEPS),
    turnOpen,
    goal: goal.length > 600 ? goal.slice(0, 600) + '…' : goal,
    truncated,
  };
}

/** 组装给外部模型的现场材料。 */
export function buildMaterial(sv, minutes) {
  const lines = [];
  lines.push('# 任务（用户最后一条消息原文）');
  lines.push(sv.goal || '(取不到)');
  lines.push('');
  lines.push(`# 最近 ${sv.trace.length} 次工具调用（时间顺序，越靠后越新）`);
  sv.trace.forEach((x, i) => {
    lines.push(`${i + 1}. [${x.name}] ${x.head || '(无命令)'}`);
    if (x.out) lines.push(`   结果: ${x.out}`);
    if (x.anom) lines.push(`   ⚠️ 异常(${x.anom})`);
  });
  lines.push('');
  lines.push('# 统计');
  lines.push(`- 自最后一条用户消息以来：${sv.callsSinceUser} 次工具调用`);
  lines.push(`- 期间异常输出：${sv.anomCount} 次，最长连续异常 ${sv.anomMax} 次`);
  lines.push(`- 距最后一条用户消息：约 ${minutes} 分钟（期间用户没再说话）`);
  return lines.join('\n');
}

export const QUESTION = [
  '下面是一个正在运行的编码 agent 的真实执行轨迹（它看不到这段对话）。判断它是否陷入了',
  '「反复尝试、每次局部有结果，但整体没有推进」的状态。',
  '',
  '要求：',
  '- 它仍在正常推进（只是任务长）时：conclusion 第一行只写 NO_STUCK，其余三段用一两句说理由。',
  '- 它卡住时：conclusion 指出卡在第几步、根因假设是什么；verification 给出它**还没试过**的',
  '  1 到 3 个具体方向（具体到命令、文件、检查点，不要写「再多调试调试」）。',
  '- 不要复述轨迹，不要客套，不要问问题。',
].join('\n');

/** 求援已发出时给用户/agent 的一句即时提示 —— 用户要求「触发后要有提示」。 */
export function formatAnnounce(why, steps) {
  return [
    `[Tandem 自动求援] 已把最近 ${steps} 步执行轨迹发给 Codex 复核（触发原因：${why}）。`,
    '它在后台跑，结论到了会再给你一条；先继续手上的事，不用等它。',
  ].join('\n');
}

/** 结论 → 注入正文。明确三件事：谁触发的、为什么触发、可以忽略。 */
export function formatAnswer(answer, why) {
  const a = answer || {};
  const lines = [];
  lines.push(`[Tandem 自动求援] 这次不是用户说话，也不是它自己的判断 —— 是 dsh-tandem 插件在后台判到你可能卡住了（${why}），把你的执行轨迹发给了另一个独立的模型（Codex/GPT）做复核。它的意见如下：`);
  lines.push('');
  const concl = String(a.conclusion || '').trim();
  if (/^NO_STUCK/i.test(concl)) {
    lines.push(`结论：${concl}`);
    lines.push('');
    lines.push('（它判定你仍在正常推进。本条只作背景，继续手上的事即可，不必回应。）');
    return lines.join('\n');
  }
  lines.push(`结论：${concl || '(空)'}`);
  const ev = Array.isArray(a.evidence) ? a.evidence : [];
  if (ev.length) {
    lines.push('');
    lines.push('依据：');
    for (const e of ev.slice(0, 3)) lines.push(`- ${String(e).trim()}`);
  }
  const ce = Array.isArray(a.counterexamples) ? a.counterexamples : [];
  if (ce.length) {
    lines.push('');
    lines.push('反例 / 它认为不成立的假设：');
    for (const e of ce.slice(0, 2)) lines.push(`- ${String(e).trim()}`);
  }
  const vf = Array.isArray(a.verification) ? a.verification : [];
  if (vf.length) {
    lines.push('');
    lines.push('它建议你还没试过的方向：');
    for (const e of vf.slice(0, 3)) lines.push(`- ${String(e).trim()}`);
  }
  lines.push('');
  lines.push('如果你判断这条不适用（例如你只是在做一件本来就长的事），直接忽略，不必向用户解释。');
  return lines.join('\n');
}

/** 失败也说话：「没拿到独立意见」本身就是信息，不能静默。 */
export function formatFailure(reason, hint, why) {
  const clean = String(reason || 'unknown');
  return [
    `[Tandem 自动求援] 这次不是用户说话 —— 插件在后台判到你可能卡住了（${why}），尝试请 Codex 复核，`,
    `但**没有拿到结论**（${clean}）。`,
    hint ? `提示：${hint}` : '',
    '',
    '要么稍后自己用 tandem_consult 再问一次，要么如实把当前阻塞点告诉用户。不要把这条当成已经获得过复核。',
  ]
    .filter((x) => x !== '')
    .join('\n');
}

/**
 * 建一个 rescue 实例。
 * @param config - 插件配置（DEFAULTS 合并后的）
 * @param probe - 写日志的函数
 * @param run - runConsult 注入点（测试可替换）
 */
export function createRescue({ config, probe = () => {}, run = runConsult } = {}) {
  /** sessionId -> { lastFireAt, pending, inflight, fired, session } */
  const states = new Map();

  const callsThreshold = Math.max(3, Number(config?.rescueAfterCalls) || 15);
  const minutesThreshold = Math.max(1, Number(config?.rescueAfterMin) || 10);
  const cooldownMs = Math.max(1, Number(config?.rescueCooldownMin) || 20) * 60_000;
  const maxPerSession = Math.max(1, Number(config?.rescueMaxPerSession) || 3);
  const timeoutMs = Math.max(30_000, Number(config?.rescueTimeoutMs) || 150_000);
  /**
   * 结论有效期。给得比「一次正常工具调用」宽很多 —— 因为最需要它的场景恰恰是单次调用挂死，
   * 那时 post-execute 要等工具超时才回来，10 分钟的有效期会在结论到手前就过期。
   */
  const ttlMs = Math.max(1, Number(config?.rescueTtlMin) || 30) * 60_000;

  function stateOf(id) {
    let st = states.get(id);
    if (!st) {
      st = { lastFireAt: 0, pending: null, announce: null, inflight: false, fired: 0, session: null, lastSeenAt: 0, firedForUserAt: 0 };
      states.set(id, st);
    }
    return st;
  }

  function whyOf(sv, factor) {
    const mins = sv.lastUserAt ? Math.round((Date.now() - sv.lastUserAt) / 60000) : null;
    const parts = [`自上次用户消息以来 ${sv.callsSinceUser} 次工具调用`];
    if (mins !== null) parts.push(`${mins} 分钟没有用户消息`);
    if (factor) parts.push(factor);
    return parts.join('，');
  }

  /** 真正发问（后台，不阻塞工具调用）。 */
  function fire(id, sv, factor) {
    const st = stateOf(id);
    st.inflight = true;
    st.fired += 1;
    st.lastFireAt = Date.now();
    // 记下「这次求援是针对哪一条用户消息之后的现场」—— 交付时拿它比对，
    // 用户中途开口换了任务，这条结论就不该再塞进去。
    st.firedForUserAt = sv.lastUserAt;
    const why = whyOf(sv, factor);
    const minutes = sv.lastUserAt ? Math.max(1, Math.round((Date.now() - sv.lastUserAt) / 60000)) : 0;
    const material = buildMaterial(sv, minutes);
    // 触发即提示：用户明确要求「触发后要有提示」，不能等 60 秒后结论回来才第一次露面。
    st.announce = formatAnnounce(why, sv.trace.length);
    probe(`rescue fire -> session ${id} (${why})`);

    run({
      mode: 'review',
      question: QUESTION,
      context: material,
      options: [],
      timeoutMs,
      cwd: '',
      paths: [],
      config: { ...config, auto: true },
    })
      .then((res) => {
        const answer = res && res.answer;
        if (res && res.ok && answer && (answer.conclusion || '').trim() !== '') {
          st.pending = { text: formatAnswer(answer, why), at: Date.now() };
          probe(`rescue answer ok -> session ${id}`);
        } else {
          const reason = (res && (res.reason || res.error)) || 'empty_answer';
          const hint = (res && res.hint) || '';
          st.pending = { text: formatFailure(reason, hint, why), at: Date.now() };
          probe(`rescue answer FAILED -> session ${id}: ${reason}`);
        }
      })
      .catch((error) => {
        const reason = (error && error.message) || 'spawn_failed';
        st.pending = { text: formatFailure(reason, '', why), at: Date.now() };
        probe(`rescue answer threw -> session ${id}: ${reason}`);
      })
      .finally(() => {
        st.inflight = false;
      });
  }

  /** 判据：够不够格问一句。返回触发原因（空串 = 不触发）。 */
  function shouldFire(st, sv, now) {
    if (st.inflight) return '';
    if (st.fired >= maxPerSession) return '';
    if (now - st.lastFireAt < cooldownMs) return '';
    if (!sv.turnOpen) return ''; // 在等用户，别打扰
    if (sv.callsSinceUser < callsThreshold) return '';
    const silentMs = sv.lastUserAt ? now - sv.lastUserAt : Number.POSITIVE_INFINITY;
    if (silentMs < minutesThreshold * 60_000) return '';
    // 加速因子：连续 ≥3 次异常。它必须和主判据同时成立 —— 单点触发会大量误报（60 个历史会话里
    // 连续异常段 ≥3 只出现过 4 次，但静默链 ≥30 次的占 15/60，两个信号都很脏）。
    if (sv.anomMax >= 3) return `连续 ${sv.anomMax} 次异常输出`;
    return '长时间无用户消息';
  }

  /**
   * 每次工具调用之后调一次。返回要注入的文本（null = 不注入）。
   * @param session - exec.agent.session
   */
  function observe(session) {
    const id = session?.id || '(unknown)';
    const st = stateOf(id);
    st.session = session;
    st.lastSeenAt = Date.now();
    const sv = survey(session?.events);
    const now = Date.now();

    // 0) 「已经发出求援」这句即时提示先交付 —— 出事了要让用户当场看见，不是三分钟后。
    if (st.announce) {
      const text = st.announce;
      st.announce = null;
      probe(`rescue announce -> session ${id}`);
      return text;
    }

    // 1) 再交付上一轮的结论（无论判定如何，结论到了就该给它看到）
    if (st.pending) {
      const age = now - st.pending.at;
      const text = st.pending.text;
      st.pending = null;
      // 场景校验优先于 TTL：用户中途开口（可能换了任务），结论就作废 ——
      // 旧任务的建议注入新任务，比不问还糟。
      if (sv.lastUserAt !== st.firedForUserAt) {
        probe(`rescue drop superseded -> session ${id} (用户在求援期间说了话)`);
      } else if (age > ttlMs) {
        probe(`rescue drop stale -> session ${id} (age ${Math.round(age / 1000)}s)`);
      } else {
        probe(`rescue deliver -> session ${id} (age ${Math.round(age / 1000)}s)`);
        return text;
      }
    }

    // 2) 判定要不要问
    const factor = shouldFire(st, sv, now);
    if (factor) {
      fire(id, sv, factor);
      // 同一次工具调用里就把「已发出求援」交出去：提示不该拖到下一次调用才露面。
      if (st.announce) {
        const text = st.announce;
        st.announce = null;
        probe(`rescue announce -> session ${id}`);
        return text;
      }
    }
    return null;
  }

  /** 单个会话状态保留多久：超过就清掉，别让 states 无限攒 session 引用。 */
  const STATE_TTL_MS = 2 * 60 * 60_000;

  /** 定时补漏：单次工具调用自己挂住时 post-execute 永远不回来，只能靠 timer 看。 */
  function tick() {
    const now = Date.now();
    for (const [id, st] of states) {
      // 只回收「从没触发过」的：把触发过的删掉等于把每会话上限归零，2 小时后又能再问一遍。
      if (now - st.lastSeenAt > STATE_TTL_MS && !st.inflight && !st.pending && st.fired === 0) {
        states.delete(id);
        continue;
      }
      const session = st.session;
      if (!session) continue;
      let sv;
      try {
        sv = survey(session.events);
      } catch {
        continue;
      }
      if (!sv.turnOpen) continue;
      const factor = shouldFire(st, sv, now);
      if (factor) fire(id, sv, factor);
    }
  }

  function dispose() {
    states.clear();
  }

  return { observe, tick, dispose, _states: states };
}

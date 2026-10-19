/**
 * 改动账本（review ledger）—— 把「这轮改了哪些文件、哪些还没有会审覆盖」变成插件能看见的事实。
 *
 * 为什么需要它：AGENTS.md 的「共审第二判」是靠模型自觉执行的，而 2026-10-19 那次性能优化
 * 一共 6 处改动、一次都没审。自觉不可验证，所以把判据落到可观测的写事件上：
 *
 *   主数据源：fs/write-intent 与 fs/edit-intent —— 任何走 fs 服务的写入都过这条线，
 *             包括 run_code 里的嵌套工具调用（内核 dsh-tools 的嵌套分发同样走 scheduler.prepare）。
 *   兜  底：tools/post-execute 里按工具名 + 参数抽路径。ops_replace / ops_batch 这类走
 *           外部 ops 服务的工具不经过 fs 服务，只能靠参数认。
 *
 * 「已审」的判据（两条同时成立）：
 *   1. 存在一条会审记录，其 at 晚于该文件最后一次改动时间；
 *   2. 该记录的 paths 覆盖这个文件（前缀匹配，见 reviews.reviewCovers）。
 *
 * 为什么用「mtime + 会审时间」而不再复核 reviews 里的聚合指纹：指纹要重算整个目录（最多 300 个
 * 文件、每个 1MB），而这里每次工具调用都要判一次 —— 代价不可接受。时间条件反而更严：
 * 它连「hooks 看不见的改动」（例如 bash 跑的脚本写文件）都能靠 mtime 抓到，
 * 而指纹是在会审那一刻算的、只覆盖那一刻的内容。指纹仍用于票据（tandem_check 的 stale 判定）。
 *
 * 账本落盘到 <stateDir>/ledger.jsonl：DSH 一重启内存就没了，不落盘的话「重启前改的东西」
 * 可以在重启后直接蒙混过去（会审反例，2026-10-19）。
 *
 * 明确的边界（不假装覆盖）：
 *  - 防的是「忘了审」，不是「刻意伪造」。reviews.jsonl 与 ledger.jsonl 都在磁盘上，
 *    能写文件的人就能改它们；要防伪造得引入签名与密钥，代价与收益不匹配。
 *  - 判据宁可保守：「会审时间 == 文件 mtime」判**未审**（多审一次比漏放好）。
 *  - 文件被删掉后从账本摘除：内容都不在了，不再要求会审（交付 git diff 场景下删除确实
 *    可能值得审，但那是另一套机制的事，不在本账本的口径里）。
 *  - 慢于记账的写入（例如 bash 跑的脚本改文件）靠 mtime 兜住：只要该文件进过账本，
 *    mtime 一变就重新算未审。从未进过账本的文件不在覆盖范围内。
 *
 * 所有异常都吞掉 —— 账本坏了不能让宿主工具崩。
 */
import { statSync, appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, extname, isAbsolute, join, sep } from 'node:path';
import { loadReviews, reviewsFile, reviewCovers } from './reviews.js';

/** 与会审指纹的 CODE_EXT 完全对齐：账本认的「代码/文档」必须和指纹认的是同一批扩展名。 */
const TRACK_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.yml', '.yaml',
  '.py', '.rs', '.go', '.toml', '.css', '.html', '.sh',
]);

/** 这些目录里的改动与会审无关（依赖、构建产物、状态目录）。 */
const SKIP_SEG = new Set([
  'node_modules', '.git', '.svn', 'dist', 'build', 'coverage', '.next', '.cache',
  '__pycache__', '.venv', 'vendor', 'tandem-state',
]);

export function ledgerFile(stateDir) {
  return join(stateDir, 'ledger.jsonl');
}

export function deliveriesFile(stateDir) {
  return join(stateDir, 'deliveries.jsonl');
}

/** 账本文件的自清理上限：超过就按当前内存快照重写。 */
const MAX_LINES = 400;
const KEEP_LINES = 200;

/** 纯笔记/日志文件：AGENTS.md 明确说「记笔记不算动手改文件」，不该触发会审提醒。 */
const SKIP_FILE = new Set(['_inbox.md', 'load.log']);

/** 走外部服务、不经过 fs 服务的写工具 —— 只能从参数里认路径。 */
const WRITE_TOOLS = new Set(['write', 'edit', 'ops_replace', 'ops_batch', 'ops_write', 'apply_patch', 'str_replace_editor']);

/** 这个路径要不要进账本。 */
export function isTrackedPath(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  // 相对路径不记账：账本判不了它属于哪个工作目录，猜错会留一条永远清不掉的假条目。
  // 主数据源（fs 意图的 displayPath）本来就是绝对路径。
  if (!isAbsolute(raw.trim())) return false;
  const abs = resolve(raw.trim());
  const name = abs.slice(abs.lastIndexOf('\\') + 1).toLowerCase();
  if (SKIP_FILE.has(name)) return false;
  if (!TRACK_EXT.has(extname(abs).toLowerCase())) return false;
  const segs = abs.toLowerCase().split(/[\\/]+/);
  for (const s of segs) {
    if (SKIP_SEG.has(s)) return false;
  }
  return true;
}

/** 从工具名与参数里兜底抽路径（fs 意图没触发时的第二来源）。 */
export function extractToolPaths(name, args) {
  if (!WRITE_TOOLS.has(name) || !args || typeof args !== 'object') return [];
  const out = [];
  const push = (v) => {
    if (typeof v === 'string' && v.trim()) out.push(v);
  };
  push(args.file_path);
  push(args.path);
  push(args.target);
  if (Array.isArray(args.paths)) args.paths.forEach(push);
  if (Array.isArray(args.operations)) {
    for (const op of args.operations) {
      if (!op || typeof op !== 'object') continue;
      push(op.path);
      push(op.from);
      push(op.to);
    }
  }
  return out;
}

function key(target) {
  const abs = resolve(String(target).trim());
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function clock(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

/**
 * @param {object} opts
 * @param {string} opts.stateDir      会审记录的落盘目录
 * @param {number} opts.firstAt       未审文件达到几个才第一次提醒（默认 2）
 * @param {number} opts.every         之后每多几个再提醒一次（默认 4）
 * @param {(msg: string) => void} opts.log 自证日志
 */
export function createLedger({ stateDir, firstAt = 2, every = 4, persist = true, log = () => {} } = {}) {
  /** 绝对路径(小写) -> { path, t, existed } */
  const changes = new Map();
  let lines = 0;
  // 只排除「插件自己的账本目录」，不是一刀切排除所有叫 state 的目录。
  // 会审反例（2026-10-19）：按目录段排除 state 会让「改动正好落在某个 state 目录下」变成直接绕过。
  const statePrefix = stateDir ? key(stateDir) : '';
  function trackable(rawPath) {
    if (!isTrackedPath(rawPath)) return false;
    if (!statePrefix) return true;
    const k = key(rawPath);
    return k !== statePrefix && !k.startsWith(statePrefix + sep);
  }

  /** 会话 -> 上次提醒时的未审文件数 */
  const watermark = new Map();
  /** 已经拦过一次的会话（未审集合清空后重置） */
  const gated = new Set();
  let cache = { key: -1, list: [] };

  /** 会审记录：文件没变就不重读（post-execute 会高频调用） */
  function reviews() {
    let sig = 0;
    try {
      const st = statSync(reviewsFile(stateDir));
      sig = st.mtimeMs + st.size;
    } catch {
      sig = 0;
    }
    if (sig !== cache.key) {
      let list = [];
      try {
        list = loadReviews(stateDir);
      } catch (err) {
        log('ledger: loadReviews failed: ' + err.message);
      }
      cache = { key: sig, list };
    }
    return cache.list;
  }

  function latestAt() {
    const list = reviews();
    for (let i = list.length - 1; i >= 0; i--) {
      const at = Date.parse(list[i].at || '');
      if (Number.isFinite(at)) return at;
    }
    return 0;
  }

  /** 把当前内存快照重写成账本文件（只保留最近的 KEEP_LINES 条）。 */
  function compact() {
    if (!persist || !stateDir) return;
    try {
      const rows = [...changes.values()].sort((a, b) => a.t - b.t).slice(-KEEP_LINES);
      const file = ledgerFile(stateDir);
      const tmp = file + '.tmp';
      writeFileSync(tmp, rows.map((r) => JSON.stringify({ path: r.path, t: r.t })).join('\n') + '\n');
      renameSync(tmp, file);
      lines = rows.length;
    } catch (err) {
      log('ledger compact failed: ' + err.message);
    }
  }

  /** 启动时把上一次进程留下的改动恢复回来 —— 重启不该是一次洗白。 */
  (function restore() {
    if (!persist || !stateDir) return;
    let text = '';
    try {
      const file = ledgerFile(stateDir);
      if (!existsSync(file)) return;
      text = readFileSync(file, 'utf8');
    } catch (err) {
      log('ledger restore read failed: ' + err.message);
      return;
    }
    let kept = 0;
    for (const line of text.split('\n')) {
      const raw = line.trim();
      if (!raw) continue;
      lines++;
      let item = null;
      try {
        item = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!item || typeof item.path !== 'string' || !trackable(item.path)) continue;
      const abs = resolve(item.path);
      const k = key(abs);
      const t = Number(item.t) || 0;
      const prev = changes.get(k);
      if (prev && prev.t >= t) continue;
      let existed = false;
      try {
        existed = statSync(abs).isFile();
      } catch {}
      changes.set(k, { path: abs, t, existed });
      kept++;
    }
    if (kept > 0) log('restored ' + kept + ' tracked path(s) from ledger');
  })();

  /** 记一次改动。返回 true 表示这是一个新进账本的路径。 */
  function note(rawPath, session) {
    if (!trackable(rawPath)) return false;
    const abs = resolve(String(rawPath).trim());
    const k = key(abs);
    let existed = false;
    try {
      existed = statSync(abs).isFile();
    } catch {
      existed = false;
    }
    const isNew = !changes.has(k);
    const prev = changes.get(k);
    const rec = { path: abs, t: Date.now(), existed: existed || (prev ? prev.existed : false) };
    changes.set(k, rec);
    if (persist && stateDir) {
      try {
        mkdirSync(stateDir, { recursive: true });
        appendFileSync(ledgerFile(stateDir), JSON.stringify({ path: rec.path, t: rec.t }) + '\n');
        if (++lines >= MAX_LINES) compact();
      } catch (err) {
        log('ledger append failed: ' + err.message);
      }
    }
    return isNew;
  }

  /** 未审列表（新改动在前）。 */
  function unreviewed() {
    const list = reviews();
    const bad = [];
    for (const [k, info] of changes) {
      let mtime = 0;
      try {
        const st = statSync(info.path);
        mtime = st.isFile() ? st.mtimeMs : 0;
      } catch {
        mtime = 0;
      }
      // 曾经存在、现在没了 = 被删掉，内容都不在了，不必再要求会审。
      if (!mtime && info.existed && Date.now() - info.t > 10000) {
        changes.delete(k);
        continue;
      }
      const t = Math.max(info.t, mtime);
      let ok = false;
      for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i];
        const at = Date.parse(r.at || '');
        if (!Number.isFinite(at)) continue;
        if (at <= t) break; // 记录按时间递增，更早的不可能覆盖这次改动
        if (!reviewCovers(r, info.path)) continue;
        ok = true;
        break;
      }
      if (!ok) bad.push({ path: info.path, t });
    }
    bad.sort((a, b) => b.t - a.t);
    return bad;
  }

  function text(bad, isGate) {
    const shown = bad.slice(0, 4).map((b) => '  - ' + b.path + '（' + clock(b.t) + ' 改）');
    const more = bad.length > 4 ? '  ...另有 ' + (bad.length - 4) + ' 个' : '';
    const head = isGate
      ? '[会审闸] present 被拦下一次：本会话有 ' + bad.length + ' 个改动不在任何会审覆盖范围内。'
      : '[会审闸] 本会话有 ' + bad.length + ' 个改动不在任何会审覆盖范围内：';
    return [
      head,
      ...shown,
      more,
      '',
      '判据（AGENTS.md 共审第二判）：会审记录的时间要晚于文件最后修改时间、覆盖该路径。',
      '要清掉它：tandem_consult(..., paths=["目录或文件"]) —— 只有带 paths 的会审才签发覆盖凭证。',
      '若这次改动确实属于「改文案 / 错别字 / 跑命令」这类无需设计的动作，忽略本条即可。',
      isGate
        ? '这是同一批未审改动的唯一一次拦截，确认后重发 present 即可放行。'
        : '再堆积 ' + every + ' 个未审文件会再提醒一次；present 交付闸会拦第一次。',
    ]
      .filter((l) => l !== undefined)
      .join('\n');
  }

  /** 交付留痕：present 放行时如果还有未审改动，落一行账。返回被记录的未审列表（空数组表示干净）。 */
  function noteDelivery(session, action) {
    const bad = unreviewed();
    if (bad.length === 0) return [];
    if (persist && stateDir) {
      try {
        mkdirSync(stateDir, { recursive: true });
        appendFileSync(
          deliveriesFile(stateDir),
          JSON.stringify({
            at: Date.now(),
            session: session || '',
            action: action || 'present',
            count: bad.length,
            files: bad.slice(0, 20).map((b) => b.path),
          }) + '\n',
        );
      } catch (err) {
        log('delivery append failed: ' + err.message);
      }
    }
    return bad;
  }

  /** 交付账本的最后一条（没有就 null）。 */
  function lastDelivery() {
    if (!persist || !stateDir) return null;
    let text = '';
    try {
      const file = deliveriesFile(stateDir);
      if (!existsSync(file)) return null;
      text = readFileSync(file, 'utf8');
    } catch (err) {
      log('delivery read failed: ' + err.message);
      return null;
    }
    const rows = text.split('\n').filter((l) => l.trim());
    if (rows.length === 0) return null;
    try {
      return JSON.parse(rows[rows.length - 1]);
    } catch {
      return null;
    }
  }

  return {
    /** fs 意图 / 工具兜底进来的入口 */
    note,
    noteDelivery,
    lastDelivery,
    noteToolPaths(name, args, session) {
      let added = 0;
      for (const p of extractToolPaths(name, args)) {
        if (note(p, session)) added++;
      }
      return added;
    },
    /** 需要提醒就返回文本，否则 null。同一会话按水位去重。 */
    reminder(session) {
      const k = session || '';
      const bad = unreviewed();
      if (bad.length === 0) {
        watermark.delete(k);
        gated.delete(k);
        return null;
      }
      const seen = watermark.get(k) || 0;
      if (bad.length < Math.max(1, firstAt)) return null;
      if (seen && bad.length < seen + Math.max(1, every)) return null;
      watermark.set(k, bad.length);
      return text(bad, false);
    },
    /** present 交付闸：同一批未审改动只拦一次。第二次返回 null（放行），由 post-execute 负责留痕。 */
    gate(session) {
      const k = session || '';
      const bad = unreviewed();
      if (bad.length === 0) {
        gated.delete(k);
        return null;
      }
      if (gated.has(k)) return null;
      gated.add(k);
      return text(bad, true);
    },
    /**
     * 放行时的明示。会审反例原话（2026-10-19）：「同一批未审改动首次被 deny、第二次直接放行；
     * 模型只需重试一次即可交付」。拦不死（拦死会让「用户明确说别审了」变成无法交付），
     * 所以改成「可以放行，但必须留痕 + 在对话里说出来」。
     */
    deliveryWarning(session, action) {
      const bad = noteDelivery(session, action);
      if (bad.length === 0) return null;
      return [
        '[会审闸] 这次交付（' + (action || 'present') + '）含 ' + bad.length + ' 个未经会审的改动，已记入交付账本。',
        ...bad.slice(0, 4).map((b) => '  - ' + b.path + '（' + clock(b.t) + ' 改）'),
        bad.length > 4 ? '  ...另有 ' + (bad.length - 4) + ' 个' : '',
        '账本：' + deliveriesFile(stateDir || '') + '（tandem_status 的 reviewGuard.lastDelivery 可查）',
      ]
        .filter(Boolean)
        .join('\n');
    },
    /** tandem_status 的体检数据。 */
    summary() {
      const bad = unreviewed();
      const list = reviews();
      return {
        tracked: changes.size,
        unreviewed: bad.length,
        files: bad.slice(0, 8).map((b) => b.path),
        reviews: list.length,
        lastConsultAt: latestAt() ? new Date(latestAt()).toISOString() : null,
        lastDelivery: lastDelivery(),
      };
    },
  };
}

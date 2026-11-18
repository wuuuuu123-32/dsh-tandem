// 时间显示：账本里存的是 UTC，直接截断显示会被人当本地时间读错。
//
// 由来（2026-11-19，真实误判）：
//   `consult-rework.json` 里 `rec.at` 存的是 UTC ISO 串（`2026-11-17T15:46:46.852Z`）。
//   原来拒绝文案里只有一句
//       String(rec.at || '').replace('T', ' ').slice(0, 16)
//   它**既不做时区换算、也不标出这是 UTC**，于是在 UTC+8 的机器上显示成「2026-11-17 15:46」。
//   我看到这行，拿它去比会话起点（本地 23:10），差七个多小时，就得出「额度在这次对话开始前
//   就被用掉了」这个结论，还把插件当成有 bug 报给了用户 —— 实际那次会审发生在本地 23:46，
//   即会话开始之后 36 分钟，账一点没错。
//
// 教训不是「我看走眼了」：一个不带时区标注的时间戳，**任何读者都会按本地时间理解**。
// 所以这里的契约是「要么给出带标注的本地时间，要么给出一个明显不是时间的占位」，
// 不允许出现「看起来像本地时间的裸 UTC」。
//
// 为什么不复用 consult.js 的 localDay()：它是**日期**粒度（YYYY-MM-DD，给 portdan 的
// 「每天一次」锁文件用的），而这里要的是秒级时刻；且 consult.js 依赖链很重
// （spawn / tickets / reviews），不适合被 rework.js 和 budget.js 反向依赖。
// 本模块只依赖 Date，谁都能引，也不会成环。

/** 时区标注，如 `UTC+8` / `UTC` / `UTC-5` / `UTC+5:30`。 */
export function zoneLabel(d = new Date()) {
  // getTimezoneOffset() 是「本地转 UTC 要加的分钟数」，东八区返回 -480，所以取反。
  const mins = -d.getTimezoneOffset();
  if (!Number.isFinite(mins) || mins === 0) return 'UTC';
  const sign = mins > 0 ? '+' : '-';
  const abs = Math.abs(mins);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return 'UTC' + sign + h + (m ? ':' + String(m).padStart(2, '0') : '');
}

/** 解析成毫秒；认不出来返回 null（**不要**退回 Date.now()，那会把坏数据伪装成「刚刚」）。 */
export function parseTs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/**
 * 人读的时间戳：本地时区 + 显式时区标注，例如 `2026-11-17 23:46:46 (UTC+8)`。
 *
 * ❗本地时间放前面、标注放括号里，是为了让「一眼扫到的是自己能对上的钟点」，
 *   同时那个括号随时纠正「这不是 UTC」。反过来（UTC 在前）会让人继续按 UTC 心算。
 *
 * @param {string|number|Date} v  UTC ISO 串 / 毫秒 / Date
 * @param {{seconds?: boolean, zone?: boolean}} [opts] seconds=false 只到分钟；zone=false 不带标注
 * @returns {string} 解析不出来时返回明确不是时间的占位串，绝不返回空串或猜测值
 */
export function localStamp(v, opts = {}) {
  const { seconds = true, zone = true } = opts;
  const t = parseTs(v);
  if (t === null) {
    const raw = String(v === null || v === undefined ? '' : v).trim();
    // 空 → 「时间未知」；有值但读不懂 → 带上原文（截断）方便排查，且一眼看出它坏了。
    if (!raw) return '时间未知';
    return '时间无法解析(' + raw.slice(0, 24) + ')';
  }
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  const body = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    + (seconds ? ':' + p(d.getSeconds()) : '');
  return zone ? body + ' (' + zoneLabel(d) + ')' : body;
}

/** 只要「几点几分」（本地），用于「今天什么时候改的」这类短标注。 */
export function localClock(v) {
  const t = parseTs(v);
  if (t === null) return '--:--';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

// 材料覆盖必须绑定「实际发出去的 prompt」，不能只看材料清单。
//
// 由来：第 24 轮会审 portdan 的构造 —— 直接调导出的 runConsultParallel，传
// materialItems=[{path, real, text}] 但 materials=''，覆盖检查按 real 路径认账、
// 新鲜度检查因没有 sha 跳过，于是 prompt 里一个字都没有，凭证照样签发。
import { checkMaterialCoverage, coverageFromPrompt } from '../lib/consult.js';

let bad = 0;
const chk = (ok, name, extra = '') => {
  if (!ok) bad++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  ' + extra : ''));
};

const A = 'D:\\x\\a.js';
const B = 'D:\\x\\b.js';
const items = [
  { path: A, real: A, text: 'AAA' },
  { path: B, real: B, text: 'BBB' },
];

console.log('== coverageFromPrompt');

// ① 内容真的在 prompt 里 → 覆盖成立
{
  const r = coverageFromPrompt([A], items, '标题\nAAA\n尾巴');
  chk(r.ok === true && r.via[A] === 'file', '内容在 prompt 里 → 覆盖成立', JSON.stringify(r.detail));
}

// ② prompt 是空的 → 不成立（这就是那条构造）
{
  const r = coverageFromPrompt([A], items, '');
  chk(r.ok === false && /prompt/.test(r.detail), 'prompt 为空 → 覆盖不成立', JSON.stringify(r.detail));
}

// ③ 只送了一个文件，却声明两个 → 缺的那个点名
{
  const r = coverageFromPrompt([A, B], items, '只有 AAA');
  chk(r.ok === false && r.missing.includes(B) && !r.missing.includes(A), '只送了一个 → 另一个点名', JSON.stringify(r.missing));
}

// ④ 内容被截断（清单里有、prompt 里只有前半段）→ 不算覆盖
{
  const cut = [{ path: A, real: A, text: 'AAA' }];
  const r = coverageFromPrompt([A], cut, 'AA');
  chk(r.ok === false, '内容被截断 → 不算覆盖', JSON.stringify(r.detail));
}

// ⑤ 目录型 paths 一律不成立（与 checkMaterialCoverage 同一条规则）
{
  const dir = process.cwd();
  const r = coverageFromPrompt([dir], items, 'AAA');
  chk(r.ok === false, '目录型 paths → 不成立', JSON.stringify(r.detail));
}

// ⑥ 清单里没有这个文件 → 不成立（不能靠 prompt 里恰好有同样的字蒙过去）
{
  const r = coverageFromPrompt([B], [items[0]], 'AAA');
  chk(r.ok === false, '清单里没有该文件 → 不成立', JSON.stringify(r.detail));
}

// ⑦ 没有材料项（只传了 prompt 文本）→ 不成立，绝不采信调用方自称
{
  const r = coverageFromPrompt([A], [], 'AAA');
  chk(r.ok === false, '没有材料清单 → 不成立', JSON.stringify(r.detail));
}

// ⑧ 回归：checkMaterialCoverage 本身仍然认清单（coverageFromPrompt 是它的超集）
{
  const r = checkMaterialCoverage([A], { items });
  chk(r.ok === true, 'checkMaterialCoverage 仍按清单认账');
}

console.log(bad === 0 ? '\n全部符合' : '\n有 ' + bad + ' 条不符合');
process.exit(bad === 0 ? 0 : 1);

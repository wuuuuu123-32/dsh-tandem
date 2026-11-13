// checkMaterialCoverage 的实测。
// 起因：我第一次给 review-d 准备材料时，材料是 diff、paths 指源文件，覆盖面直接判 false ——
// 这是第 ⑥ 条禁令在起作用，但也说明「按同一文件名比对」这个实现过于死板：
// 审一次改动时交给 judge 的本来就该是 diff。
//
// ❗2026-11-13 改（第 16 轮会审 portdan 的反例）：diff 覆盖必须能证明「这份 diff 真的对应
// 工作区当前内容」，否则随手写一行 `+++ b/x` 加一个 `@@` 就能替任何文件作证。
// 所以这里建一个**真 git 仓库**，用真 `git diff` 产物测，而不是手搓字符串。
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { checkMaterialCoverage, collectMaterials } from '../lib/consult.js';

const root = 'D:/dsh/config/.tmp-cover-test';
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
mkdirSync(root + '/src', { recursive: true });

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', windowsHide: true });
git('init', '-q');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'test');

writeFileSync(root + '/src/a.js', 'export const a = 0;\n');
writeFileSync(root + '/src/b.js', 'export const b = 2;\n');
git('add', '.');
git('commit', '-qm', 'init');
// 制造一处真实改动，并让 a.js 的工作区内容与 diff 一致（=「改完还没提交」的常态）
writeFileSync(root + '/src/a.js', 'export const a = 1;\n');
const realDiff = git('diff', '--', 'src/a.js');
writeFileSync(root + '/change.diff', realDiff);
// ❗CRLF 形态：Windows 上 Out-File / Set-Content 写出来的就是这种。
// 实现里会先规范化成 LF 再交给 git，所以它必须一样能认。
writeFileSync(root + '/change-crlf.diff', realDiff.replace(/\n/g, '\r\n'));

const A = root + '/src/a.js';
const B = root + '/src/b.js';

let bad = 0;
// via 的键是 normalizePaths 规范化后的写法（Windows 反斜杠），查询时要一起规范化
const viaOf = (cov, p) => {
  const k = String(p).replace(/\//g, '\\').toLowerCase();
  for (const [kk, vv] of Object.entries(cov.via || {})) {
    if (String(kk).toLowerCase() === k) return vv;
  }
  return undefined;
};
const t = (name, cov, wantOk, wantVia) => {
  const got = wantVia ? viaOf(cov, A) : undefined;
  const ok = cov.ok === wantOk && (!wantVia || got === wantVia);
  if (!ok) bad++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + ' → ok=' + cov.ok + ' via=' + JSON.stringify(cov.via)
    + (cov.missing.length ? ' missing=' + JSON.stringify(cov.missing) : ''));
};

// ① 文件本身进了 prompt
t('a.js 直接注入', checkMaterialCoverage([A], collectMaterials([A], { roots: [root], base: root })), true, 'file');

// ② 真 diff（git apply --check --reverse 能过）→ 认，方式记为 diff
t('只给 diff 覆盖 a.js', checkMaterialCoverage([A], collectMaterials(['change.diff'], { roots: [root], base: root })), true, 'diff');

// ②b CRLF 写出来的 diff 必须一样能认（否则「禁令太严」的错觉会再次出现）
t('CRLF diff 覆盖 a.js', checkMaterialCoverage([A], collectMaterials(['change-crlf.diff'], { roots: [root], base: root })), true, 'diff');

// ②c 过期 diff：把 a.js 改成与 diff 不符的样子 → 必须判 mismatch、不给覆盖
{
  writeFileSync(root + '/src/a.js', 'export const a = 999;\n');
  t('过期 diff（工作区已变）不覆盖 a.js', checkMaterialCoverage([A], collectMaterials(['change.diff'], { roots: [root], base: root })), false);
  writeFileSync(root + '/src/a.js', 'export const a = 1;\n');
}

// ②d 伪造 diff：hunk 的 + 行与工作区当前内容对不上 → 反向应用必然失败
{
  const fake = ['diff --git a/src/a.js b/src/a.js', '--- a/src/a.js', '+++ b/src/a.js',
    '@@ -1 +1 @@', '-export const a = 0;', '+export const a = 777;'].join('\n') + '\n';
  writeFileSync(root + '/fake.diff', fake);
  t('伪造 diff（+ 行与工作区不符）不覆盖 a.js', checkMaterialCoverage([A], collectMaterials(['fake.diff'], { roots: [root], base: root })), false);
}

// ③ diff 没提到的文件不能被 diff 顺带覆盖（否则「一份 diff 覆盖全部 paths」）
t('diff 不含 b.js → 不覆盖 b', checkMaterialCoverage([B], collectMaterials(['change.diff'], { roots: [root], base: root })), false);

// ④ 什么都没注入
t('没注入任何材料', checkMaterialCoverage([A], collectMaterials([], { roots: [root], base: root })), false);

// ⑤ 目录型 path：**一律不覆盖**（第 15 轮会审 quna-sonnet 指出：目录里只要有一个文件进了
// prompt 就声称「整个目录被审过」，那种凭证比没有更坏。要审目录请逐个列出文件）
t('目录型 paths 不给覆盖', checkMaterialCoverage([root + '/src'], collectMaterials([A], { roots: [root], base: root })), false);

// ⑥ 名字对但内容不同的文件不算（防「同名的另一个文件」蒙混）
{
  mkdirSync(root + '/other', { recursive: true });
  writeFileSync(root + '/other/a.js', 'x\n');
  const cov = checkMaterialCoverage([root + '/other/a.js'], collectMaterials([A], { roots: [root], base: root }));
  t('other/a.js 不等于 src/a.js', cov, false);
}

// ⑦ 只有 `+++ b/x` 一行、没有 hunk 的伪 diff 不算覆盖（第 5 轮会审 sonnet 的反例）
writeFileSync(root + '/no-hunk.diff', '+++ b/src/a.js\n');
t('伪 diff（无 @@）不覆盖 a.js', checkMaterialCoverage([A], collectMaterials(['no-hunk.diff'], { roots: [root], base: root })), false);

// ⑧ 被截断的 diff 不算覆盖（第 6 轮会审 portdan 的反例：direct 查 truncated，diff 这条没查）
{
  writeFileSync(root + '/big.diff', realDiff + ' filler\n'.repeat(20000));
  const mats = collectMaterials(['big.diff'], { roots: [root], base: root });
  const trunc = !!(mats.items[0] && mats.items[0].truncated);
  if (!trunc) bad++;
  console.log((trunc ? 'PASS' : 'FAIL') + '  big.diff 确实被截断（⑧ 的前提）');
  t('被截断的 diff 不覆盖 a.js', checkMaterialCoverage([A], mats), false);
}

// ⑨ 非 git 目录：实测 git apply 不依赖仓库（它就是个补丁工具），所以照样能核对
{
  // ❗放在仓库**外面**，否则会被上层仓库接管，测的就不是「非仓库目录」这件事了。
  const plain = 'D:/dsh/config/.tmp-cover-plain';
  if (existsSync(plain)) rmSync(plain, { recursive: true, force: true });
  mkdirSync(plain, { recursive: true });
  writeFileSync(plain + '/x.js', 'export const x = 1;\n');
  writeFileSync(plain + '/p.diff', ['diff --git a/x.js b/x.js', '--- a/x.js', '+++ b/x.js', '@@ -1 +1 @@',
    '-export const x = 0;', '+export const x = 1;'].join('\n') + '\n');
  const cov = checkMaterialCoverage([plain + '/x.js'], collectMaterials([plain + '/p.diff'], { roots: [plain], base: plain }));
  const ok = cov.ok === true && Object.values(cov.via)[0] === 'diff';
  if (!ok) bad++;
  console.log((ok ? 'PASS' : 'FAIL') + '  非 git 目录的 diff 也能核对（git apply 不依赖仓库） → ok=' + cov.ok);
  rmSync(plain, { recursive: true, force: true });
}

rmSync(root, { recursive: true, force: true });
console.log(bad ? '\n有 ' + bad + ' 条不符' : '\n全部符合');
process.exit(bad ? 1 : 0);

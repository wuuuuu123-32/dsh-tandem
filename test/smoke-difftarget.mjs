// diff 的**目标路径**也要过安全校验（第 16/17 轮会审指出），而且「对不上工作区」的补丁不许注入。
//
// 病根：collectMaterials 只校验「材料文件本身」的 realpath / basename / 目录段，
// 而 diff 会被 renderMaterials 整份贴进 prompt。一份 `.env` 的补丁里，
// 被删掉的那几行带着明文密钥（`-OPENAI_API_KEY=sk-...`）——补丁本身就是凭据，
// 只看文件名永远拦不住。
//
// 第 17 轮又补了另一半：删除 / 改名时新路径是 `/dev/null`，只解析 `+++` 会让目标集变空。
//
// ⚠️这份测试用**真的 git 仓库**产出真 diff，且在「改完之后、回滚之前」立刻校验：
//   · 手写的假 diff 会被 verifyDiffInTree 判成 mismatch 而整份拒绝（这也是要验的行为），
//     用它测目标路径，测到的其实是「假 diff 被拒」而不是「目标被查」；
//   · 先回滚再校验，真 diff 也会变成「对不上工作区」——第一版就栽在这。
// 用 `git diff HEAD`（不是 `git diff`）：`git rm` / `git mv` 把改动放进了暂存区，
// 只跑 `git diff` 会拿到空补丁。
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectMaterials } from '../lib/consult.js';

const root = 'D:/dsh/config/.tmp-difftarget-test';
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, 'src'), { recursive: true });
mkdirSync(join(root, '.ssh'), { recursive: true });

const git = (args, allowFail = false) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 && !allowFail) throw new Error('git ' + args.join(' ') + ' 失败：' + (r.stderr || r.stdout));
  return (r.stdout || '').trim();
};

const writeEnv = (v) => writeFileSync(join(root, '.env'), 'OPENAI_API_KEY=' + v + '\nDB_PASSWORD=hunter2\n');
writeEnv('sk-live-真实密钥');
writeFileSync(join(root, '.ssh', 'config'), 'Host *\n  User root\n');
writeFileSync(join(root, 'src', 'app.js'), 'export const a = 1;\n');
writeFileSync(join(root, 'src', 'old.js'), 'export const x = 1;\n');
writeFileSync(join(root, 'src', 'note.txt'), '-- 这是一行被删掉的注释\nkeep\n');
// 生成的 diff 留在仓库里（diffTargets 按 diff 文件所在目录解析目标路径），
// 但必须被 ignore 掉，否则回滚时的 `git clean -fd` 会把它删了。
writeFileSync(join(root, '.gitignore'), '*.diff\n');

git(['init', '-q']);
git(['config', 'user.email', 't@example.com']);
git(['config', 'user.name', 't']);
git(['add', '-A']);
git(['commit', '-qm', 'base']);

const reset = () => { git(['reset', '-q', '--hard']); git(['clean', '-qfd']); };

let bad = 0;
/** 造改动 → 产出真 diff → 立刻校验 → 回滚。 */
const check = (name, mutate, wantReject, expectWord, label, roots) => {
  mutate();
  const path = join(root, name);
  writeFileSync(path, git(['diff', 'HEAD', '--unified=3', '-M']) + '\n');
  const r = collectMaterials([path], { roots: roots || [root], base: root });
  const rejected = r.rejected.length > 0;
  const reason = rejected ? r.rejected[0].reason : '';
  const wordOk = !expectWord || reason.includes(expectWord);
  const ok = rejected === wantReject && wordOk;
  if (!ok) bad++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + ' → ' +
    (rejected ? '拒绝（' + reason + '）' : '读入 ' + (r.items[0] ? r.items[0].bytes : 0) + 'B'));
  reset();
};

check('leak.diff', () => writeEnv('sk-live-轮换后的'), true, '禁止外送', '改 .env 的补丁被拒');
check('sshdiff.diff', () => writeFileSync(join(root, '.ssh', 'config'), 'Host *\n  User evil\n'), true, '禁止外送', '改 .ssh/config 的补丁被拒');
check('del.diff', () => git(['rm', '-q', '.env']), true, '禁止外送', '删除 .env 的补丁被拒（旧路径）');
// 改名**且**改内容：纯改名时 git 只输出头部、没有 hunk，也就没有任何内容可泄漏；
// 真正危险的形态是「改名 + 仍有改动行」，那时 `-OPENAI_API_KEY=...` 就躺在 hunk 里。
check('rename.diff', () => {
  git(['mv', '.env', 'notes.txt']);
  writeFileSync(join(root, 'notes.txt'), 'OPENAI_API_KEY=sk-live-轮换后的\nDB_PASSWORD=hunter2\n');
}, true, '禁止外送', '把 .env 改名并改内容的补丁被拒');
check('leak2.diff', () => writeEnv('sk-live-轮换后的'), true, '不在允许的目录内', '目标越出允许根的补丁被拒', [join(root, 'src')]);
check('ok.diff', () => writeFileSync(join(root, 'src', 'app.js'), 'export const a = 2;\n'), false, null, '正常改动照常读入');
check('del-ok.diff', () => git(['rm', '-q', 'src/old.js']), false, null, '删除普通文件照常读入');
// hunk 里被删掉的行内容以 `-- ` 开头（diff 前缀之后长成 `--- 这是一行...`）→ 不许当成文件头
check('tricky.diff', () => writeFileSync(join(root, 'src', 'note.txt'), 'keep\n'), false, null, 'hunk 里形似文件头的删除行不被当成路径');
check('ok2.diff', () => writeFileSync(join(root, 'src', 'app.js'), 'export const a = 3;\n'), false, null, '允许根含子目录时仍可读', [root, join(root, 'src')]);

// 手写假 diff —— 对不上工作区，必须整份拒绝（不是「不算覆盖」而是不注入）
const fakeDiff = join(root, 'fake.diff');
writeFileSync(fakeDiff, [
  'diff --git a/src/app.js b/src/app.js',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1 +1 @@',
  '-export const a = 999;',
  '+export const a = 1000;',
  '',
].join('\n'));
{
  const r = collectMaterials([fakeDiff], { roots: [root], base: root });
  const ok = r.rejected.length > 0 && r.rejected[0].reason.includes('对不上');
  if (!ok) bad++;
  console.log((ok ? 'PASS' : 'FAIL') + '  对不上工作区的假 diff 整份拒绝 → ' + (r.rejected[0] ? r.rejected[0].reason : '读入了'));
}
// workRoots 为空时一个都不许读
{
  const r = collectMaterials([fakeDiff], { roots: [], base: root });
  const ok = r.rejected.length > 0 && r.rejected[0].reason.includes('未配置允许根');
  if (!ok) bad++;
  console.log((ok ? 'PASS' : 'FAIL') + '  workRoots 为空时一个都不读 → ' + (r.rejected[0] ? r.rejected[0].reason : '读入了'));
}

rmSync(root, { recursive: true, force: true });
console.log(bad === 0 ? '\n全部通过' : '\n失败 ' + bad + ' 条');
process.exit(bad === 0 ? 0 : 1);

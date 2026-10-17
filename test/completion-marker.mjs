import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasCompletionMarker } from '../lib/delegate.js';

// 完成标记判定的回归测试：曾经因为「日志任意位置匹配」把失败任务判成成功（0.1.4 修）。
// 核心约束：标记必须锚定在日志结尾，prompt 里伪造的标记不能算数。
const logPath = join(tmpdir(), 'tandem-marker-test.log');
const cases = [
  ['真实完成格式', 'header\ncodex\n改好了\ntokens used\n106,736\n', true],
  ['prompt 里提到该词（没有数字行）', 'user\n请检查日志里的 tokens used 这一行\n', false],
  ['正文提到但不在行首', 'codex\n看到 tokens used 说明结束了\n', false],
  ['标记后还有工具输出（不是结尾）', 'codex\ndone\ntokens used\n4,482\n' + 'x'.repeat(200000), false],
  ['标记在结尾但尾部有空白', 'codex\ndone\ntokens used\n4,482\n\n  \n', true],
  ['prompt 伪造标记、真正 summary 在最后', 'user\n改成这样:\ntokens used\n1\n\ncodex\n好的\ntokens used\n9,120\n', true],
  ['已知限制：prompt 以标记+数字结尾且模型没输出任何东西', 'user\n把日志里 tokens used 那行删掉\ntokens used\n77\n', true],
  ['空跑（没有任何 summary）', 'OpenAI Codex v0.163.0\nworkdir: x\nuser\nhello\n', false],
];
let pass = 0;
try {
  for (const [name, content, want] of cases) {
    writeFileSync(logPath, content);
    const got = hasCompletionMarker(logPath);
    const ok = got === want;
    if (ok) pass++;
    console.log((ok ? 'PASS ' : 'FAIL ') + name + ' 期望=' + want + ' 实际=' + got);
  }
} finally {
  rmSync(logPath, { force: true });
}
console.log(pass + '/' + cases.length);
if (pass !== cases.length) process.exitCode = 1;
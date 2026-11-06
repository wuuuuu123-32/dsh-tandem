// 会审后端链路的规则测试：不联网、不起 codex，只验「这次该问谁」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planStages, localDay, readProviderState, writeProviderState, tfCoolingDown, CONSULT_PROVIDERS, TF_EXHAUST_TTL } from '../lib/consult.js';

let pass = 0, fail = 0;
const t = (name, actual, expect) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expect);
  if (a === e) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + '  期望=' + e + ' 实际=' + a); }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tandem-chain-'));

// 1) 当天第一次：portdan 打头，带 dailyPick
{
  const dir = tmp();
  const s = planStages(dir);
  t('首次 → 顺序 pd/tf/aisz', s.map(x => x.tag), ['portdan', 'tokenfuture', 'aisz']);
  t('首次 → 只有第一家带 dailyPick', s.map(x => !!x.dailyPick), [true, false, false]);
  t('首次 → 会在磁盘留下当天认领文件', fs.readdirSync(dir).some(f => f.startsWith('portdan-used-')), true);
}
// 2) 同一天第二次：锁已存在 → tf 打头
{
  const dir = tmp();
  planStages(dir);
  const s = planStages(dir);
  t('当天第二次 → 顺序 tf/pd/aisz', s.map(x => x.tag), ['tokenfuture', 'portdan', 'aisz']);
  t('当天第二次 → 没有 dailyPick', s.some(x => x.dailyPick), false);
}
// 3) tf 处于没余额退避期 → 整条链跳过它
{
  const dir = tmp();
  writeProviderState(dir, { tfExhaustedAt: Date.now() - 1000, tfExhaustedReason: 'insufficient balance' });
  t('tf 冷却中 → 首次链 pd/aisz', planStages(dir).map(x => x.tag), ['portdan', 'aisz']);
  const dir2 = tmp();
  writeProviderState(dir2, { tfExhaustedAt: Date.now() - 1000 });
  planStages(dir2);
  t('tf 冷却中 → 非首次链 pd/aisz', planStages(dir2).map(x => x.tag), ['portdan', 'aisz']);
}
// 4) 退避到期 → tf 回到链里
{
  const dir = tmp();
  writeProviderState(dir, { tfExhaustedAt: Date.now() - TF_EXHAUST_TTL - 1000 });
  t('tf 退避过期 → 冷却判定为 false', tfCoolingDown(readProviderState(dir)), false);
  planStages(dir);
  t('tf 退避过期 → 非首次仍以 tf 打头', planStages(dir).map(x => x.tag), ['tokenfuture', 'portdan', 'aisz']);
}
// 5) 跨天：昨天的日期不该挡住今天
{
  const dir = tmp();
  writeProviderState(dir, { lastPortdanDay: '2000-01-01' });
  t('跨天 → 今天仍算首次', planStages(dir).map(x => x.tag), ['portdan', 'tokenfuture', 'aisz']);
}
// 6) 显式 pin 与 failover 的语义
{
  const dir = tmp();
  const pin = planStages(dir, { profile: { ...CONSULT_PROVIDERS.aisz, name: 'aisz' } });
  t('显式 pin aisz → 只有一家', pin.map(x => x.tag), ['aisz']);
  const pinF = planStages(dir, { profile: { ...CONSULT_PROVIDERS.portdan, name: 'portdan' }, failover: true });
  t('pin portdan + failover:true → 补 aisz', pinF.map(x => x.tag), ['portdan', 'aisz']);
  const off = planStages(dir, { failover: false });
  t('failover:false → 只问 portdan', off.map(x => x.tag), ['portdan']);
}
// 7) 状态文件损坏 / 缺失不该让链路崩
{
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'provider-state.json'), '{坏 JSON');
  t('状态文件损坏 → 读到空对象', readProviderState(dir), {});
  t('状态文件损坏 → 链路仍可用', planStages(dir).length > 0, true);
  const dir2 = tmp();
  t('状态文件缺失 → 读到空对象', readProviderState(dir2), {});
}
// 8) localDay 是本地时区的 YYYY-MM-DD
{
  const d = localDay(new Date(2026, 0, 5, 23, 30).getTime());
  t('localDay 不按 UTC 切天', d, '2026-01-05');
  t('localDay 格式', /^\d{4}-\d{2}-\d{2}$/.test(localDay()), true);
}
// 9) 三个后端都带 baseURL（否则 codex 会回落到 config.toml 里的旧网关）
{
  t('每家都有 baseURL', Object.values(CONSULT_PROVIDERS).every(p => /^https:\/\//.test(p.baseURL || '')), true);
  t('tf 与 portdan 同模型', CONSULT_PROVIDERS.tokenfuture.model, CONSULT_PROVIDERS.portdan.model);
}
console.log((fail ? 'FAILED ' : 'ALL PASS ') + pass + '/' + (pass + fail));
process.exit(fail ? 1 : 0);

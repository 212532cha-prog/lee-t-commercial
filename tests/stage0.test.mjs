import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
test('required project documents are present',()=>{for(const file of ['PRD.md','开发计划.md','验收清单.md'])assert.ok(fs.statSync(file).size>1000)});
test('secret and production paths are gitignored',()=>{const ignore=fs.readFileSync('.gitignore','utf8').split('\n');for(const p of ['.env','*.key','backups/','data/'])assert.ok(ignore.includes(p),p)});
test('stage zero checker executes',()=>assert.match(execFileSync(process.execPath,['scripts/check-stage0.mjs'],{encoding:'utf8'}),/passed/));
test('PRD documents LAN deployment',()=>assert.match(fs.readFileSync('PRD.md','utf8'),/局域网/));
// Replaces the old count-writing assumption; explicit migration evidence is mandatory.
test('ADR-001 replacement preserves atomic reports and forbids inventory mutation',()=>{
  const historical=fs.readFileSync('docs/decisions/ADR-001-inventory-count-conflict.md','utf8');
  const current=fs.readFileSync('docs/decisions/ADR-003-confirmed-revision-20261101.md','utf8');
  const prd=fs.readFileSync('PRD.md','utf8');
  assert.ok(historical.startsWith('> **当前已由 ADR-003'));
  for(const text of ['COUNT-T11','取消/接管旧轮次拒绝','入出库并发仍测试'])assert.ok(current.includes(text),text);
  for(const text of ['失败不产生部分报告','重复提交只产生一份报告','不写库存交易、不改余额、不增加库存版本'])assert.ok(prd.includes(text),text);
});
test('ADR-002 replacement maps changed rules and preserves unaffected requirements',()=>{
  const current=fs.readFileSync('docs/decisions/ADR-003-confirmed-revision-20261101.md','utf8');
  const prd=fs.readFileSync('PRD.md','utf8');
  for(const text of ['HIST-T05','PURGE-T01','AUTH-T08','没有降低真机门槛'])assert.ok(current.includes(text),text);
  for(const text of ['P000001','02:00','最近操作最多 10 条','负库存按负价值','清理不撤销交易，也不改变当前库存','不提供计量单位字段','不提供产品回收站','只有一个管理员账号'])assert.ok(prd.includes(text),text);
});
test('Windows server preflight is read-only and collects deployment requirements',()=>{
 const script=fs.readFileSync('scripts/windows-preflight.ps1','utf8');
 for(const token of ['Get-CimInstance','Win32_OperatingSystem','TotalPhysicalMemory','FreeSpace','Get-NetIPConfiguration','ConvertTo-Json','BackupPath1','BackupPath2','NotTested'])assert.ok(script.includes(token),token);
 for(const forbidden of ['Set-NetFirewallRule','New-NetFirewallRule','Set-ExecutionPolicy','Remove-Item','Invoke-WebRequest','Start-Process'])assert.ok(!script.includes(forbidden),forbidden);
});
test('LAN deployment plan preserves mandatory real-device acceptance gates',()=>{
 const plan=fs.readFileSync('docs/deployment/windows-lan-preflight.md','utf8');
 for(const item of ['GitHub','Windows','HTTPS','iPhone','Android','恢复演练','未验证'])assert.ok(plan.includes(item),item);
});

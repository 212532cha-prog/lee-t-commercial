import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {inspectGates,requiredGates,developmentGates,deviceGates} from '../src/preflight/gates.mjs';
const fixture=()=>({stage:0,revision:'REQ-20261101',gates:requiredGates.map(id=>({id,status:'passed',evidence:'test-fixture-only',verifiedAt:'2026-11-01T00:00:00Z'}))});
test('development gate requires every engineering check; device gate remains mandatory for deployment',()=>{const r=fixture();assert.equal(inspectGates(r).passed,true);r.gates.find(g=>g.id==='trusted-https-iphone').status='pending';assert.equal(inspectGates(r).passed,true);assert.equal(inspectGates(r,{scope:'deployment'}).passed,false)});
test('passing label with no evidence or invalid time is not accepted',()=>{for(const mutate of [r=>delete r.gates[0].evidence,r=>r.gates[0].verifiedAt='invalid',r=>r.gates.push(r.gates[0]),r=>r.revision='old']){const r=fixture();mutate(r);assert.equal(inspectGates(r).passed,false)}});
test('actual engineering gate passes while real device gate refuses unverified hardware',()=>{const report=JSON.parse(readFileSync('docs/deployment/stage0-gates.json','utf8'));assert.equal(inspectGates(report).passed,true);const deployment=inspectGates(report,{scope:'deployment'});assert.equal(deployment.passed,false);for(const id of deviceGates)assert.ok(deployment.blocked.some(g=>g.id===id));for(const [args,status,scope] of [[[],0,'development'],[['--require-devices'],1,'deployment']]){const cli=spawnSync(process.execPath,['scripts/check-stage0-gate.mjs',...args],{encoding:'utf8'});assert.equal(cli.status,status);assert.equal(JSON.parse(cli.stdout).scope,scope)}});
test('device checks cannot be removed by changing scope or dropping checks',()=>{const r=fixture();r.gates=r.gates.filter(g=>developmentGates.includes(g.id));assert.equal(inspectGates(r).passed,true);assert.equal(inspectGates(r,{scope:'deployment'}).passed,false);assert.equal(inspectGates(r,{scope:'fake'}).passed,false)});

test('formal deployment cannot pass with only the initial four device checks',()=>{
 const report=fixture();
 assert.equal(inspectGates(report,{scope:'deployment'}).passed,true);
 const additional=[
  'physical-hid-and-labels','lan-loss-and-reconnect','windows-unattended-restart',
  'warehouse-network-exposure','physical-backup-volumes','physical-machine-restore',
  'upgrade-and-rollback','warehouse-user-acceptance',
 ];
 for(const id of additional){
  const partial={...report,gates:report.gates.filter(gate=>gate.id!==id)};
  assert.deepEqual(inspectGates(partial,{scope:'deployment'}).blocked,[{id,reason:'not verified'}]);
  assert.equal(inspectGates(partial).passed,true);
 }
});

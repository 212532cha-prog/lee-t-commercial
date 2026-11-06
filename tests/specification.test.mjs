import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inspectSpecification} from '../src/preflight/specification.mjs';
const load=()=>({prd:readFileSync('PRD.md','utf8'),plan:readFileSync('开发计划.md','utf8'),acceptance:readFileSync('验收清单.md','utf8')});
test('73 current requirements map to 117 actionable acceptance cases',()=>assert.deepEqual(inspectSpecification(load()),{requirements:73,cases:117,errors:[]}));
test('a missing mapped case cannot silently drop a requirement',()=>{const spec=load();spec.acceptance=spec.acceptance.replace(/^\| MASTER-T03 \|.*\n/m,'');assert.ok(inspectSpecification(spec).errors.includes('uncovered requirement: MASTER-02'))});
test('unknown and duplicate acceptance IDs are rejected',()=>{const spec=load();const row=spec.acceptance.split('\n').find(l=>l.startsWith('| AUTH-T01 |'));spec.acceptance+='\n'+row+'\n';spec.acceptance=spec.acceptance.replace('AUTH-01 |','UNKNOWN-77 |');const report=inspectSpecification(spec);assert.ok(report.errors.some(e=>e.includes('duplicate acceptance')));assert.ok(report.errors.some(e=>e.includes('unknown UNKNOWN-77')))});
test('putting back count stock writes fails specification checks',()=>{const spec=load();spec.prd=spec.prd.replace('不写库存交易、不改余额、不增加库存版本','提交后覆盖余额并增加版本');assert.ok(inspectSpecification(spec).errors.includes('count must never mutate inventory'))});
test('document structure does not claim business acceptance has run',()=>{const text=load().acceptance;assert.equal((text.match(/\| 未执行 \|$/gm)||[]).length,117);assert.ok(!/\[x\]|\| 通过 \|$/m.test(text))});

test('portable backup and deferred hardware remain explicit, not a fake IP-only migration',()=>{const s=load();for(const text of ['### BACKUP-12','### CONS-06','换机不等于只修改IP','不删除用例或降低标准'])assert.ok(s.prd.includes(text),text);for(const id of ['RESTORE-T07','RESTORE-T08','ENV-T06','DOC-T02'])assert.ok(s.acceptance.includes(id),id)});

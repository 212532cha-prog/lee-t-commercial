import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {buildLicenseEdge} from '../scripts/build-license-edge.mjs';
test('standalone Edge bundle is reproducible, hashed and carries complete runtime license notices',async t=>{
 const root=await mkdtemp(join(tmpdir(),'leet-edge-build-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const first=await buildLicenseEdge(join(root,'first')),second=await buildLicenseEdge(join(root,'second'));
 assert.equal(first.bundle.sha256,second.bundle.sha256);assert.deepEqual(first.sources,second.sources);
 const bytes=await readFile(join(root,'first',first.bundle.file));assert.equal(first.bundle.bytes,bytes.length);assert.equal(first.bundle.sha256,createHash('sha256').update(bytes).digest('hex'));
 const license=await readFile(join(root,'first','THIRD-PARTY-LICENSES.txt'),'utf8');
 assert.ok(first.dependencies.some(row=>row.name==='pg'&&row.version==='8.23.1'));assert.ok(first.dependencies.some(row=>row.name==='pg-types'));
 assert.match(bytes.toString('utf8'),/THIRD-PARTY LICENSE NOTICES/);assert.match(bytes.toString('utf8'),/Copyright \(c\) 2014 Brian M\. Carlson/);
 assert.match(license,/Copyright \(c\) 2014 Brian M\. Carlson/);assert.match(license,/Permission is hereby granted/);assert.match(license,/pg@8\.23\.1/);
 assert.ok(!first.sources.some(row=>row.path.includes('server-license.mjs')||row.path.includes('activation-client.mjs')),'deployment must not import the Windows/filesystem activation client');
 await writeFile(join(root,'first','preserved.txt'),'existing artifact');await assert.rejects(buildLicenseEdge(join(root,'first')),e=>e.code==='EEXIST');assert.equal(await readFile(join(root,'first','preserved.txt'),'utf8'),'existing artifact');
});

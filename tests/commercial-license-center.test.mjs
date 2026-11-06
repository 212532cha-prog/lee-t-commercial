import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeviceRequest, generateIssuerKeyPair, verifyLicense } from '../src/commercial/license.mjs';
import { PilotLicenseCenter } from '../src/commercial/license-center.mjs';

const request = createDeviceRequest({ device:{ machineId:'A',boardId:'B',systemDiskId:'C'},installationId:'install-A'});
async function setup(t) {
 const dir=await mkdtemp(join(tmpdir(),'leet-lic-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const keys=generateIssuerKeyPair();
 const filename=join(dir,'licenses.json');
 const center=new PilotLicenseCenter({filename,privateKeyPem:keys.privateKeyPem,keyId:'issuer-1'});
 return {center,keys,filename};
}
test('paid activation code is single use, persisted and signed', async t=>{
 const {center,keys,filename}=await setup(t);
 await assert.rejects(center.createActivationCode({customerId:'A',version:'1.0.0',paid:false}),/payment/);
 const code=await center.createActivationCode({customerId:'A',version:'1.0.0',paid:true});
 assert.match(code,/^LT-/);
 const lic=await center.redeemActivationCode({code,request});
 assert.equal(verifyLicense({license:lic,publicKeyPem:keys.publicKeyPem,request,runningVersion:'1.0.0'}).valid,true);
 await assert.rejects(center.redeemActivationCode({code,request}),/already redeemed/);
 assert.equal((await center.summary()).redeemed,1);
 assert.equal((await readFile(filename,'utf8')).includes(code),false);
});
test('concurrent redemption is serialized, one winner',async t=>{
 const {center}=await setup(t);
 const code=await center.createActivationCode({customerId:'A',version:'1.0.0',paid:true});
 const attempts=await Promise.allSettled(Array.from({length:20},()=>center.redeemActivationCode({code,request})));
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(attempts.filter(r=>r.status==='rejected').length,19);
});
test('bad request does not consume activation',async t=>{
 const {center}=await setup(t);
 const code=await center.createActivationCode({customerId:'A',version:'1.0.0',paid:true});
 await assert.rejects(center.redeemActivationCode({code,request:{}}));
 assert.ok(await center.redeemActivationCode({code,request}));
});
test('upgrade requires a prior license and explicit payment',async t=>{
 const {center}=await setup(t);
 await assert.rejects(center.createActivationCode({customerId:'A',version:'2.0.0',kind:'upgrade',paid:true}),/previous license/);
 const code=await center.createActivationCode({customerId:'A',version:'2.0.0',kind:'upgrade',priorLicenseId:'old',paid:true});
 const lic=await center.redeemActivationCode({code,request});
 assert.equal(lic.payload.priorLicenseId,'old');
 assert.equal(lic.payload.entitledVersion,'2.0.0');
});

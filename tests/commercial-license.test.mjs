import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceRequest, generateIssuerKeyPair, issueLicense, verifyLicense } from '../src/commercial/license.mjs';
const issuer = generateIssuerKeyPair();
const machine = { machineId: 'windows-guid-A', boardId: 'mainboard-A', systemDiskId: 'disk-A' };
const request = createDeviceRequest({ device: machine, installationId: 'installed-instance-A' });
const issue = (overrides={}) => issueLicense({ privateKeyPem: issuer.privateKeyPem, keyId:'key-2026', request, customerId:'customer-1', version:'1.4.0', issuedAt:'2026-11-06T08:00:00.000Z', ...overrides });
const verify = (license, overrides={}) => verifyLicense({ license, publicKeyPem:issuer.publicKeyPem, request, runningVersion:'1.4.0', ...overrides });
test('issuer generates Ed25519 keys and signed license verifies offline', () => {
 const l=issue(); assert.equal(verify(l).valid,true); assert.equal(verify(l,{runningVersion:'1.3.9'}).valid,true);
 assert.equal(verify(l,{runningVersion:'1.4.1'}).valid,false);
});
test('modified entitlement, customer or installation cannot bypass signature', () => {
 const l=issue(); for(const k of ['entitledVersion','customerId','installationId']) {
  const bad=structuredClone(l);bad.payload[k]='forged';assert.equal(verify(bad).valid,false,k);
 }
});
test('other customer license and wrong signer rejected', () => {
 const l=issue();const other=generateIssuerKeyPair();assert.equal(verify(l,{publicKeyPem:other.publicKeyPem}).valid,false);
 assert.equal(verify(l,{allowedKeyIds:['different-key']}).valid,false);
});
test('a minor hardware replacement is tolerated but installation clone and new machine are rejected',()=>{
 const l=issue();
 const replaceDisk=createDeviceRequest({device:{...machine,systemDiskId:'new-disk'},installationId:request.installationId});
 assert.equal(verify(l,{request:replaceDisk}).valid,true);
 const replaceTwo=createDeviceRequest({device:{...machine,systemDiskId:'new-disk',boardId:'new-board'},installationId:request.installationId});
 assert.equal(verify(l,{request:replaceTwo}).valid,false);
 const copy=createDeviceRequest({device:machine,installationId:'another-instance'});
 assert.equal(verify(l,{request:copy}).valid,false);
});
test('invalid activation request and versions are rejected',()=>{
 assert.throws(()=>createDeviceRequest({device:{machineId:'a',boardId:'b'}}));
 assert.throws(()=>issue({version:'latest'}));
 assert.throws(()=>issue({kind:'upgrade'}));
 const upgraded=issue({kind:'upgrade', priorLicenseId:'old-license', version:'2.0.0'});
 assert.equal(verify(upgraded,{runningVersion:'2.0.0'}).valid,true);
});
test('license does not contain raw hardware identifying strings or private keys',()=>{
 const output=JSON.stringify(issue());
 for(const raw of Object.values(machine)) assert.equal(output.includes(raw),false);
 assert.equal(output.includes('PRIVATE KEY'),false);
});

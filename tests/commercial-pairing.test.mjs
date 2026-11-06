import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalPairingAuthority, makeDiscoveryRecord } from '../src/commercial/pairing.mjs';
test('discovery record advertises unique server identity and LAN service',()=>{
 const d=makeDiscoveryRecord({serverId:'b1a97ccb-72f1-4b11-8ae1-f335cf49c290',port:3000,host:'leetserver.local'});
 assert.equal(d.service,'_leet-warehouse._tcp');assert.equal(d.port,3000);
 assert.throws(()=>makeDiscoveryRecord({...d,port:0}));
});
test('pair invitation is ephemeral, single-use and has no admin license',()=>{
 const p=new LocalPairingAuthority();const qr=p.newInvitation();
 assert.equal(qr.type,'leet-local-pairing');assert.equal(JSON.stringify(qr).includes('license'),false);
 assert.equal(p.consumeInvitation(qr),true);assert.equal(p.consumeInvitation(qr),false);
});
test('rejects tamper, other servers and expiry without consuming legitimate token',()=>{
 let now=1000;const p=new LocalPairingAuthority({now:()=>now});
 const q=p.newInvitation({ttlMs:1500});
 assert.equal(p.consumeInvitation({...q,token:'forged'}),false);
 assert.equal(new LocalPairingAuthority().consumeInvitation(q),false);
 assert.equal(p.consumeInvitation(q),true);
 const q2=p.newInvitation({ttlMs:1500});now+=1500;
 assert.equal(p.consumeInvitation(q2),false);
});

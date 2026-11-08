import test from 'node:test';
import assert from 'node:assert/strict';
import {createCleanupController} from '../integrations/ruoyi-vue3/src/views/leet/cleanup-controller.mjs';
function fixture(){
 const saved=new Map(),calls=[],prompts=[];let confirmations=0;
 const storage={getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)};
 const api={session:async()=>({user:{id:'owner',role:'admin'}}),clean:async(id,data)=>{calls.push({id,data:structuredClone(data)});return {deleted:2,hasMore:false};},status:async()=>{throw Object.assign(Error('missing'),{code:'CLEANUP_REQUEST_NOT_FOUND'});}};
 const options={api,storage,uuid:()=> 'request',confirm:async(text,title)=>{prompts.push(title);confirmations++;},updated:async()=>{}};
 return {saved,calls,prompts,api,storage,options,get confirmations(){return confirmations;},make:()=>createCleanupController(options)};
}
test('cleanup persists before sending, confirms twice and does not turn postcommit refresh failure into an unknown deletion',async()=>{
 const f=fixture();f.options.updated=()=>{throw Error('offline');};f.api.clean=async(id,data)=>{assert.equal(JSON.parse(f.saved.get('warehouse-pending:owner:cleanup')).requestId,data.requestId);return {deleted:2,hasMore:true};};
 const c=f.make();await c.initialize('product',null);await c.start({ids:['1','2']});assert.equal(f.confirmations,2);assert.equal(c.state.pending,null);assert.match(c.state.notice,/2 records deleted/);assert.match(c.state.notice,/More eligible records/);assert.match(c.state.error,/Cleanup is confirmed/);
});
test('either cleanup confirmation can be cancelled without sending or saving',async()=>{
 for(const cancelAt of [1,2]){const f=fixture();let n=0;f.options.confirm=async()=>{if(++n===cancelAt)throw 'cancel';};const c=f.make();await c.initialize('product',null);await c.start({ids:['1']});assert.equal(f.calls.length,0);assert.equal(f.saved.size,0);assert.equal(c.state.pending,null);}
});
test('network and expired login preserve the exact original request across reload and same-id retry',async()=>{
 const f=fixture();f.api.clean=async(id,data)=>{f.calls.push(structuredClone(data));throw Object.assign(Error('expired'),{code:'LOGIN_REQUIRED'});};
 let c=f.make();await c.initialize('product',null);await c.start({cutoff:'2026-01-01T23:59:59.999+08:00'});const original=structuredClone(c.state.pending);assert.equal(original.requestId,'request');
 c=f.make();await c.initialize('product',null);await c.verify();assert.equal(c.state.missing,true);assert.deepEqual(c.state.pending,original);await c.retry();assert.deepEqual(f.calls,[original,original]);
 f.api.status=async()=>({deleted:3,hasMore:false});await c.verify();assert.equal(c.state.pending,null);assert.equal(f.saved.size,0);assert.match(c.state.notice,/3 records deleted/);
});
test('quota and unavailable storage prevent every cleanup POST including retries',async()=>{
 const f=fixture();f.storage.setItem=()=>{throw Error('QuotaExceededError');};let c=f.make();await c.initialize('product',null);await c.start({ids:['1']});assert.equal(f.calls.length,0);assert.equal(c.state.pending,null);
 f.saved.set('warehouse-pending:owner:cleanup',JSON.stringify({productId:'product',requestId:'old',ids:['1']}));c=f.make();await c.initialize('product',null);await c.retry();assert.equal(f.calls.length,0);assert.equal(c.state.pending.requestId,'old');
 f.options.storage=undefined;c=f.make();await c.initialize('product',null);await c.start({ids:['1']});assert.equal(f.calls.length,0);assert.match(c.state.error,/Local storage/);
});
test('another product pending blocks a fresh cleanup and retry while allowing result verification',async()=>{
 const f=fixture();f.saved.set('warehouse-pending:owner:cleanup',JSON.stringify({productId:'other',requestId:'pending',ids:['1']}));const c=f.make();await c.initialize('product',null);await c.start({ids:['2']});await c.retry();assert.equal(f.calls.length,0);
 f.api.status=async(id,request)=>{assert.equal(id,'other');assert.equal(request,'pending');return {deleted:1};};await c.verify();assert.equal(c.state.pending,null);
});
test('obsolete requests require a verified missing result and two confirmations; a late confirmed result is retained',async()=>{
 const f=fixture(),pending={productId:'product',requestId:'prior',ids:['1'],restoreMarker:null};f.saved.set('warehouse-pending:owner:cleanup',JSON.stringify(pending));let c=f.make();await c.initialize('product','restored');await c.retry();await c.discardObsolete();assert.deepEqual(c.state.pending,pending);assert.equal(f.confirmations,0);
 await c.verify();assert.equal(c.state.missing,true);f.api.status=async()=>({deleted:4});await c.discardObsolete();assert.equal(c.state.pending,null);assert.match(c.state.notice,/4 records deleted/);assert.equal(f.confirmations,0);
 f.saved.set('warehouse-pending:owner:cleanup',JSON.stringify(pending));f.api.status=async()=>{throw Object.assign(Error('missing'),{code:'CLEANUP_REQUEST_NOT_FOUND'});};c=f.make();await c.initialize('product','restored');await c.verify();await c.discardObsolete();assert.equal(f.confirmations,2);assert.equal(f.calls.length,0);assert.equal(c.state.pending,null);
});
test('failed removal of durable confirmed request keeps it recoverable instead of authorizing a second cleanup',async()=>{
 const f=fixture();f.storage.removeItem=()=>{throw Error('blocked');};const c=f.make();await c.initialize('product',null);await c.start({ids:['1']});assert.equal(c.state.pending.requestId,'request');assert.match(c.state.error,/Cleanup is confirmed/);await c.start({ids:['2']});assert.equal(f.calls.length,1);
});
test('leaving during confirmation cancels an unsubmitted cleanup',async()=>{
 const f=fixture();let controller;f.options.confirm=async()=>{controller.dispose();};controller=f.make();await controller.initialize('product',null);await controller.start({ids:['1']});assert.equal(f.calls.length,0);assert.equal(f.saved.size,0);
});

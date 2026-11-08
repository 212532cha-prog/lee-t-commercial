import test from 'node:test';
import assert from 'node:assert/strict';
import {createStockUI} from '../public/app/stock.js';
const escape=v=>String(v).replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function setup(handler,preflight){const messages=[],calls=[],memory=new Map();const ui=createStockUI({api:async(path,args)=>{calls.push({path,args});if(path==='/api/stock/preflight')return preflight?preflight(args.data):{items:args.data.items.map(line=>({...line,name:'Part',quantity:999,afterQuantity:999-line.quantity,requested:line.quantity})),expectedVersions:Object.fromEntries(args.data.items.map(line=>[line.productId,'1'])),restoreMarker:null};return handler?handler(path,args):path==='/api/stock/draft'?{draft:null}:{product:{id:'product',name:'<Bolt>',productCode:'P000001',quantity:999,individualCost:42}};},render(){},message:s=>messages.push(s),getLang:()=> 'zh',getSession:()=>({user:{id:'staff',role:'employee'}}),escape,storage:{getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)}});return {ui,messages,calls,memory};}
test('three valid identical scanner events add three and plus/minus/remove operate on merged row',async()=>{const {ui}=setup();await ui.open('inbound');for(let i=0;i<3;i++)await ui.scan('same-token');assert.equal(ui.state.items.length,1);assert.equal(ui.state.items[0].quantity,3);await ui.click({dataset:{stock:'minus',id:'product'}});assert.equal(ui.state.items[0].quantity,2);await ui.click({dataset:{stock:'plus',id:'product'}});assert.equal(ui.state.items[0].quantity,3);await ui.click({dataset:{stock:'remove',id:'product'}});assert.equal(ui.state.items.length,0);});
test('scan list hides current stock and cost, escapes product names, provides no direct quantity editor',async()=>{const {ui}=setup();await ui.open('outbound');await ui.scan('token');const html=ui.html();assert.ok(html.includes('&lt;Bolt&gt;'));for(const forbidden of ['999','individualCost','type="number"','photo'])assert.ok(!html.includes(forbidden),forbidden);assert.match(html,/id="scan-token"/);});
test('invalid scan is ignored and subsequent valid events remain usable',async()=>{const {ui,messages}=setup(path=>{if(path.includes('bad')){const e=Error('invalid');e.code='INVALID_QR';throw e;}return path.endsWith('/draft')?{draft:null}:{product:{id:'p',name:'P',productCode:'P1'}};});await ui.open('inbound');await ui.scan('bad');assert.equal(ui.state.items.length,0);assert.match(messages[0],/不存在/);await ui.scan('good');assert.equal(ui.state.items[0].quantity,1);});
test('unknown commit retains original id and payload through interruption; retry cannot duplicate request id',async()=>{let attempt=0;const {ui,memory,calls}=setup((path,args)=>{if(path==='/api/stock/draft')return {draft:null};if(path.includes('/by-token/'))return {product:{id:'p',name:'Part',productCode:'P1'}};if(path==='/api/stock/transactions'){if(!attempt++)throw Error('network lost');return {items:[{productId:'p',quantity:1,afterQuantity:1}],requestId:args.data.requestId};}throw Error('unexpected');});await ui.open('inbound');await ui.scan('qr');await ui.click({dataset:{stock:'commit'}});assert.equal(ui.state.items.length,0);assert.ok(ui.state.pending);const id=ui.state.pending.requestId;assert.equal(memory.size,1);ui.interrupt();assert.equal(ui.state.pending.requestId,id);await ui.click({dataset:{stock:'retry'}});assert.equal(ui.state.pending,null);assert.equal(memory.size,0);const requests=calls.filter(c=>c.path==='/api/stock/transactions');assert.equal(requests[0].args.data.requestId,requests[1].args.data.requestId);});
test('saved draft survives interruption while unsaved items clear',async()=>{const {ui}=setup();await ui.open('inbound');ui.state.draft={kind:'inbound',revision:'8',items:[{productId:'p',quantity:3}]};await ui.scan('new');ui.interrupt();assert.equal(ui.state.items.length,0);assert.equal(ui.state.draft.items[0].quantity,3);});
test('late scan response after interruption cannot repopulate unsaved list',async()=>{let finish;const {ui}=setup(path=>path.endsWith('/draft')?{draft:null}:new Promise(r=>finish=r));await ui.open('inbound');const pending=ui.scan('qr');ui.interrupt();finish({product:{id:'p',name:'P',productCode:'P1'}});await pending;assert.equal(ui.state.items.length,0);});
test('scan connection failure clears existing unsaved list instead of leaving a stale offline cart',async()=>{let fail=false;const {ui}=setup(path=>{if(path.endsWith('/draft'))return {draft:null};if(fail)throw Error('network');return {product:{id:'p',name:'Part',productCode:'P1'}};});await ui.open('inbound');await ui.scan('qr');fail=true;await ui.scan('qr');assert.equal(ui.state.items.length,0);});
test('internal server failure keeps unknown stock commit id until verified retry',async()=>{let attempts=0;const {ui,calls}=setup((path,args)=>{if(path.endsWith('/draft'))return {draft:null};if(path.includes('/by-token/'))return {product:{id:'p',name:'P',productCode:'P1'}};if(path==='/api/stock/transactions'){if(!attempts++){const e=Error('server failure');e.code='INTERNAL_ERROR';e.status=500;throw e;}return {items:[],requestId:args.data.requestId};}});await ui.open('inbound');await ui.scan('qr');await ui.click({dataset:{stock:'commit'}});assert.ok(ui.state.pending);const id=ui.state.pending.requestId;await ui.click({dataset:{stock:'retry'}});assert.equal(ui.state.pending,null);assert.deepEqual(calls.filter(x=>x.path==='/api/stock/transactions').map(x=>x.args.data.requestId),[id,id]);});

test('negative-stock warnings require both confirmations and preserve the list when either is cancelled',async t=>{
 const previous=globalThis.confirm;t.after(()=>{globalThis.confirm=previous;});
 for(const answers of [[false],[true,false],[true,true]]){
  const prompts=[];globalThis.confirm=text=>{prompts.push(text);return answers[prompts.length-1];};
  const {ui,calls}=setup((path,args)=>path.endsWith('/draft')?{draft:null}:path.includes('/by-token/')?{product:{id:'p',name:'Part',productCode:'P1'}}:{items:[],requestId:args.data.requestId},()=>({items:[{name:'Part',quantity:0,afterQuantity:-1,requested:1}],expectedVersions:{p:'7'},restoreMarker:null}));
  await ui.open('outbound');await ui.scan('qr');await ui.click({dataset:{stock:'commit'}});
  const writes=calls.filter(call=>call.path==='/api/stock/transactions');
  assert.equal(writes.length,answers.length===2&&answers[1]?1:0);
  assert.equal(prompts.length,answers.length);assert.match(prompts[0],/库存不足/);assert.equal(ui.state.busy,false);
  if(writes.length){assert.deepEqual(writes[0].args.data.expectedVersions,{p:'7'});assert.equal(writes[0].args.data.restoreMarker,null);}else{assert.equal(ui.state.items[0].quantity,1);assert.equal(ui.state.pending,null);}
 }
});

test('an authentication failure during retry cannot discard an earlier unconfirmed transaction',async()=>{
 let attempt=0;const {ui,calls}=setup((path,args)=>{
  if(path.endsWith('/draft'))return {draft:null};if(path.includes('/by-token/'))return {product:{id:'p',name:'Part',productCode:'P1'}};
  if(path==='/api/stock/transactions'){if(!attempt++)throw Error('lost response');if(attempt===2){const failure=Error('expired session');failure.code='SESSION_REPLACED_OR_REVOKED';throw failure;}return {items:[],requestId:args.data.requestId};}
 });
 await ui.open('inbound');await ui.scan('qr');await ui.click({dataset:{stock:'commit'}});const original=structuredClone(ui.state.pending);
 await ui.click({dataset:{stock:'retry'}});assert.deepEqual(ui.state.pending,original);
 await ui.click({dataset:{stock:'retry'}});assert.equal(ui.state.pending,null);
 assert.deepEqual(calls.filter(call=>call.path==='/api/stock/transactions').map(call=>call.args.data.requestId),[original.requestId,original.requestId,original.requestId]);
});

test('an interrupted preflight never creates or submits a pending transaction',async()=>{
 let finish;const {ui,calls}=setup(undefined,()=>new Promise(resolve=>{finish=resolve;}));
 await ui.open('inbound');await ui.scan('qr');const action=ui.click({dataset:{stock:'commit'}});ui.interrupt();
 finish({items:[],expectedVersions:{product:'1'},restoreMarker:null});await action;
 assert.equal(ui.state.pending,null);assert.equal(ui.state.items.length,0);assert.equal(ui.state.busy,false);assert.equal(calls.filter(call=>call.path==='/api/stock/transactions').length,0);
});

test('an obsolete restored-warehouse request can only be discarded after a missing-result check and confirmation',async t=>{
 const previous=globalThis.confirm;t.after(()=>{globalThis.confirm=previous;});let confirmations=0;globalThis.confirm=()=>{confirmations++;return true;};
 const {ui,calls,memory}=setup(path=>{if(path.endsWith('/draft'))return {draft:null};if(path.includes('/by-token/'))return {product:{id:'p',name:'Part',productCode:'P1'}};const failure=Error('restored');failure.code=path.includes('/requests/')?'REQUEST_NOT_FOUND':'WAREHOUSE_RESTORED';throw failure;});
 await ui.open('inbound');await ui.scan('qr');await ui.click({dataset:{stock:'commit'}});
 await ui.click({dataset:{stock:'discard-obsolete'}});assert.ok(ui.state.pending);assert.equal(confirmations,0);
 await ui.click({dataset:{stock:'retry'}});assert.equal(calls.filter(call=>call.path==='/api/stock/transactions').length,1);
 await ui.click({dataset:{stock:'verify'}});await ui.click({dataset:{stock:'discard-obsolete'}});
 assert.equal(ui.state.pending,null);assert.equal(memory.size,0);assert.equal(confirmations,2);
});

test('storage failure prevents both the first submission and retry until the same request can be retained',async()=>{
 const {ui,calls,memory}=setup((path,args)=>path.endsWith('/draft')?{draft:null}:path.includes('/by-token/')?{product:{id:'p',name:'Part',productCode:'P1'}}:{items:[],requestId:args.data.requestId});
 await ui.open('inbound');await ui.scan('qr');memory.set=()=>{throw Error('storage unavailable');};
 await ui.click({dataset:{stock:'commit'}});const id=ui.state.pending.requestId;
 await ui.click({dataset:{stock:'retry'}});assert.equal(calls.filter(call=>call.path==='/api/stock/transactions').length,0);assert.equal(ui.state.pending.requestId,id);
 memory.set=(key,value)=>Map.prototype.set.call(memory,key,value);await ui.click({dataset:{stock:'retry'}});
 const requests=calls.filter(call=>call.path==='/api/stock/transactions');assert.equal(requests.length,1);assert.equal(requests[0].args.data.requestId,id);assert.equal(ui.state.pending,null);
});

test('a failed draft refresh after a confirmed commit never turns success into an unknown transaction',async()=>{
 let reads=0;const {ui,messages,memory}=setup((path,args)=>{if(path.endsWith('/draft')){if(reads++)throw Error('draft read disconnected');return {draft:null};}if(path.includes('/by-token/'))return {product:{id:'p',name:'Part',productCode:'P1'}};return {requestId:args.data.requestId,items:[{productId:'p',name:'Part',quantity:1,afterQuantity:1}]};});
 await ui.open('inbound');await ui.scan('qr');await ui.click({dataset:{stock:'commit'}});
 assert.equal(ui.state.pending,null);assert.equal(memory.size,0);assert.equal(ui.state.result.items[0].afterQuantity,1);assert.equal(ui.state.items.length,0);assert.equal(ui.state.busy,false);
 assert.match(messages.at(-1),/库存已提交成功/);assert.ok(!messages.includes('提交结果未确认，请核验或使用原请求重试，勿重新扫描提交。'));
});

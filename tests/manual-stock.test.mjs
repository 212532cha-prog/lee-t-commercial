import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStockQuantity, setStockQuantity } from '../src/inventory/manual-stock.mjs';

test('keyboard quantity accepts zero and positive integers', () => {
  for (const [input, expected] of [['0',0],['250',250],[12,12],[' 42 ',42]]) assert.equal(parseStockQuantity(input),expected);
});
test('rejects negative, decimals, exponent, unsafe and blank inputs', () => {
  for (const input of ['-1','2.5','1e3','', '01', '9007199254740992', null]) assert.throws(()=>parseStockQuantity(input));
});
test('only enabled admin can change stock', async () => {
  const store={compareAndSetQuantity:async()=>{throw Error('must not run')}};
  for(const actor of [{role:'staff'},null,{role:'admin',disabled:true}])
    await assert.rejects(setStockQuantity({actor,productId:'P000001',quantity:'8',expectedRevision:0,store}),/FORBIDDEN/);
});
test('successful overwrite changes quantity without generating any history or audit', async () => {
  const database={quantity:10,revision:3,history:[{type:'IN',qty:10}],audit:[]};
  const store={compareAndSetQuantity:async ({quantity,expectedRevision})=>{
    if(database.revision!==expectedRevision)return false;
    database.quantity=quantity;database.revision++;return true;
  }};
  const result=await setStockQuantity({actor:{role:'admin'},productId:'P000001',quantity:'25',expectedRevision:3,store});
  assert.deepEqual(result,{productId:'P000001',quantity:25,revision:4});
  assert.equal(database.quantity,25);
  assert.deepEqual(database.history,[{type:'IN',qty:10}]);
  assert.deepEqual(database.audit,[]);
});
test('concurrent stale update fails without overwriting', async () => {
  const store={compareAndSetQuantity:async ({expectedRevision})=>expectedRevision===7};
  await assert.rejects(setStockQuantity({actor:{role:'admin'},productId:'P000001',quantity:9,expectedRevision:6,store}),/STOCK_CONFLICT/);
});
test('invalid product IDs and revisions rejected before write', async () => {
  const store={compareAndSetQuantity:async()=>{throw Error('must not run')}};
  for (const productId of ['','../users','a b']) await assert.rejects(setStockQuantity({actor:{role:'admin'},productId,quantity:1,expectedRevision:0,store}));
  await assert.rejects(setStockQuantity({actor:{role:'admin'},productId:'P000001',quantity:1,expectedRevision:-1,store}));
});

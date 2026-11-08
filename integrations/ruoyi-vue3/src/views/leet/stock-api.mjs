import { createAdminTransport } from './warehouse-api.mjs';
export function createStockClient(options = {}) {
  const {read,write}=createAdminTransport(options);
  return {
    session:signal=>read('/api/me',{signal}),
    resolve:(token,signal)=>read('/api/products/by-token/'+encodeURIComponent(token),{signal}),
    search:(q,cursor,signal)=>read('/api/products?'+new URLSearchParams({limit:'20',q,...(cursor&&{cursor})}),{signal}),
    draft:signal=>read('/api/stock/draft',{signal}),
    saveDraft:data=>write('/api/stock/draft',{method:'PUT',data}),
    discardDraft:expectedRevision=>write('/api/stock/draft',{method:'DELETE',data:{expectedRevision}}),
    preflight:data=>write('/api/stock/preflight',{method:'POST',data}),
    commit:data=>write('/api/stock/transactions',{method:'POST',data}),
    status:id=>read('/api/stock/requests/'+encodeURIComponent(id)),
  };
}

import { createAdminTransport } from './warehouse-api.mjs';
export function createCleanupClient(options = {}) {
  const {read,write}=createAdminTransport({timeoutMs:600000,...options});
  const path=id=>'/api/products/'+encodeURIComponent(id)+'/history-cleanup';
  return {
    session:()=>read('/api/me'),
    clean:(id,data)=>write(path(id),{method:'POST',data}),
    status:(id,requestId)=>read(path(id)+'/requests/'+encodeURIComponent(requestId)),
  };
}

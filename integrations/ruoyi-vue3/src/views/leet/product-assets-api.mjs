import { createAdminTransport } from './warehouse-api.mjs';

export const workbookType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export function createProductAssetsClient(options = {}) {
  const { write } = createAdminTransport(options);
  return {
    photo(id,file) { return write('/api/products/'+encodeURIComponent(id)+'/photo',{method:'PUT',raw:file,headers:{'Content-Type':file.type}}); },
    removePhoto(id) { return write('/api/products/'+encodeURIComponent(id)+'/photo',{method:'DELETE'}); },
    preview(categoryId,file) { return write('/api/products/import-preview?'+new URLSearchParams({categoryId}),{method:'POST',raw:file,headers:{'Content-Type':workbookType}}); },
    commit(categoryId,file,token) { return write('/api/products/import-commit?'+new URLSearchParams({categoryId}),{method:'POST',raw:file,headers:{'Content-Type':workbookType,'X-Import-Preview':token}}); },
  };
}

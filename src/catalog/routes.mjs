import {createHmac} from 'node:crypto';
import QRCode from 'qrcode';
import {AuthError,sameToken} from '../auth/service.mjs';
import {identifier} from './service.mjs';
import {productWorkbookTemplate,readProductWorkbook,workbookLimit,workbookType} from './import-workbook.mjs';
import {PHOTO_LIMIT} from './files.mjs';
const escape=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createCatalogRoutes({auth,catalog,photos,exporter}){
 return async function route({req,res,path,search,raw,csrf,json,body}){
  const write=!['GET','HEAD'].includes(req.method);
  if(path==='/api/master-data'&&req.method==='GET'){await auth.authorize(raw);json(res,200,await catalog.masters());return true;}
  const master=path.match(/^\/api\/(categories|suppliers|locations)(?:\/([^/]+))?$/);
  if(master&&['POST','PATCH','DELETE'].includes(req.method)){
   await auth.authorize(raw,{admin:true,write:true,csrf});const [_,kind,id]=master;
   if(!id&&req.method==='POST'){json(res,201,await catalog.addMaster(kind,await body(req),{raw,csrf}));return true;}
   if(id&&req.method==='PATCH'){json(res,200,await catalog.editMaster(kind,id,await body(req),{raw,csrf}));return true;}
   if(id&&req.method==='DELETE'){json(res,200,await catalog.deleteMaster(kind,id,{raw,csrf}));return true;}
  }
  if(path==='/api/products'&&req.method==='GET'){const a=await auth.authorize(raw);json(res,200,await catalog.list(Object.fromEntries(search),{admin:a.user.role==='admin'}));return true;}
  if(path==='/api/products/offline-inventory'&&req.method==='GET'){
   await auth.authorize(raw,{admin:true});json(res,200,await catalog.offlineInventory());return true;
  }
  if(path==='/api/products'&&req.method==='POST'){await auth.authorize(raw,{admin:true,write:true,csrf});json(res,201,await catalog.create(await body(req),{raw,csrf}));return true;}
  if(path==='/api/products/import-template'&&req.method==='GET'){
   await auth.authorize(raw,{admin:true});
   const template=await productWorkbookTemplate();
   res.writeHead(200,{'Content-Type':workbookType,'Content-Disposition':'attachment; filename="warehouse-products.xlsx"'});
   res.end(template);
   return true;
  }
  if(['/api/products/import-preview','/api/products/import-commit'].includes(path)&&req.method==='POST'){
   await auth.authorize(raw,{admin:true,write:true,csrf});
   const categoryId=identifier(search.get('categoryId'));
   if(req.headers['content-type']!==workbookType)throw new AuthError('IMPORT_XLSX_REQUIRED',415);
   if(Number(req.headers['content-length'])>workbookLimit)throw new AuthError('IMPORT_FILE_TOO_LARGE',413);
   let length=0;
   const chunks=[];
   for await(const chunk of req){length+=chunk.length;if(length>workbookLimit)throw new AuthError('IMPORT_FILE_TOO_LARGE',413);chunks.push(chunk);}
   const workbook=Buffer.concat(chunks);
   const commit=path.endsWith('commit');
   const previewToken=createHmac('sha256',raw).update('product-import:'+categoryId+':').update(workbook).digest('base64url');
   if(commit&&!sameToken(req.headers['x-import-preview'],previewToken))throw new AuthError('IMPORT_PREVIEW_REQUIRED',409);
   const result=await catalog.importProducts(categoryId,await readProductWorkbook(workbook),{commit,context:{raw,csrf}});
   if(commit)json(res,result.errors.length?409:201,result.errors.length?{error:'IMPORT_ROWS_CHANGED',errors:result.errors}:result);
   else json(res,200,{...result,previewToken:result.errors.length?null:previewToken});
   return true;
  }
  if(path==='/api/products/qr/print-batch'&&req.method==='GET'){
   await auth.authorize(raw,{admin:true});
   const ids=search.getAll('id');
   if(ids.length<1||ids.length>50||new Set(ids).size!==ids.length)throw new AuthError('INVALID_QR_BATCH');
   ids.forEach(identifier);
   const labels=[];
   for(const id of ids){
    const product=await catalog.detail(id);
    const svg=await QRCode.toString(product.qrToken,{type:'svg',width:256,margin:4,errorCorrectionLevel:'M'});
    labels.push(`<article class="qr-label">${svg}<strong>${escape(product.productCode)}</strong><span>${escape(product.name)}</span></article>`);
   }
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
   res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Product QR labels</title><link rel="stylesheet" href="/app.css"><script src="/qr-print.js" defer></script></head><body class="qr-label-sheet"><main>${labels.join('')}</main></body></html>`);
   return true;
  }
  const token=path.match(/^\/api\/products\/by-token\/([^/]+)$/);
  if(token&&req.method==='GET'){const a=await auth.authorize(raw);json(res,200,{product:await catalog.resolveToken(token[1],{admin:a.user.role==='admin'})});return true;}
  const match=path.match(/^\/api\/products\/([^/]+)(?:\/(photo|qr)(?:\/(print|download))?)?$/);
  if(!match)return false;
  const [_,id,asset,action]=match;
  const a=await auth.authorize(raw,{admin:write||!!action,write,csrf});
  if(!asset&&req.method==='GET'){json(res,200,{product:await catalog.detail(id,{admin:a.user.role==='admin'})});return true;}
  if(!asset&&req.method==='PATCH'){json(res,200,await catalog.update(id,await body(req),{raw,csrf}));return true;}
  if(!asset&&req.method==='DELETE'){
   if(req.headers['x-confirm-permanent']!=='delete-product')throw new AuthError('PERMANENT_CONFIRMATION_REQUIRED',409);
   const result=await catalog.delete(id,{raw,csrf}),photo=await photos.drain(),exports=exporter?await exporter.reap():{cleanupPending:false};json(res,200,{...result,cleanupPending:photo.cleanupPending||exports.cleanupPending});return true;
  }
  if(asset==='photo'&&!action&&req.method==='GET'){const image=await photos.get(id);res.writeHead(200,{'Content-Type':image.mime});res.end(image.buffer);return true;}
  if(asset==='photo'&&!action&&req.method==='DELETE'){json(res,200,await photos.remove(id,{raw,csrf}));return true;}
  if(asset==='photo'&&!action&&req.method==='PUT'){
   if(Number(req.headers['content-length'])>PHOTO_LIMIT)throw new AuthError('PHOTO_TOO_LARGE',413);
   const mime=req.headers['content-type'];let total=0;const chunks=[];
   for await(const chunk of req){total+=chunk.length;if(total>PHOTO_LIMIT)throw new AuthError('PHOTO_TOO_LARGE',413);chunks.push(chunk);}
   json(res,200,await photos.replace(id,Buffer.concat(chunks),mime,{raw,csrf}));return true;
  }
  if(asset==='qr'&&req.method==='GET'){
   const product=await catalog.detail(id),svg=await QRCode.toString(product.qrToken,{type:'svg',width:256,margin:4,errorCorrectionLevel:'M'});
   if(action==='print'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Product QR</title><script src="/qr-print.js" defer></script></head><body><h1>${escape(product.name)}</h1><p>${escape(product.productCode)}</p>${svg}</body></html>`);return true;
   }
   if(action==='download')res.setHeader('Content-Disposition',`attachment; filename="product-${id}.svg"`);
   res.writeHead(200,{'Content-Type':'image/svg+xml; charset=utf-8'});res.end(svg);return true;
  }
  return false;
 };
}

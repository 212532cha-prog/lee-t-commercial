import {pipeline} from 'node:stream/promises';
import {AuthError} from '../auth/service.mjs';
export function createBackupRoutes({backup,afterRestore}){
 return async({req,res,path,raw,csrf,json,body})=>{
  if(path==='/api/backups/download-full'&&req.method==='GET'){
   await backup.downloadFull(raw,async r=>{
    if(res.destroyed)return;
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':r.bytes,'Content-Disposition':`attachment; filename="${r.filename}"`});
    await pipeline(r.handle.createReadStream({autoClose:false}),res);
   });return true;
  }
  if(path==='/api/backups'&&req.method==='GET'){json(res,200,await backup.list(raw));return true;}
  if(path==='/api/backups'&&req.method==='POST'){json(res,201,await backup.create(raw,csrf));return true;}
  if(path==='/api/backups/config'&&req.method==='PUT'){const input=await body(req);if(typeof input.expectedRevision!=='string'||!/^\d+$/.test(input.expectedRevision))throw new AuthError('INVALID_VERSION');json(res,200,await backup.configure(raw,csrf,input));return true;}
  if(path==='/api/backups/upload'&&req.method==='POST'){if(req.headers['content-type']!=='application/octet-stream')throw new AuthError('BACKUP_BINARY_REQUIRED',415);json(res,201,await backup.upload(raw,csrf,req));return true;}
  if(path==='/api/backups/uploads'&&req.method==='DELETE'){json(res,200,await backup.cleanUploads(raw,csrf));return true;}
  if(path==='/api/backups/restore'&&req.method==='POST'){const result=await backup.restore(raw,csrf,await body(req));let cleanupPending=false;if(afterRestore)try{cleanupPending=(await afterRestore()).cleanupPending;}catch{cleanupPending=true;}json(res,200,{...result,cleanupPending});return true;}
  if(path==='/api/maintenance'&&req.method==='PUT'){const input=await body(req);if(input.confirm!=='change-maintenance')throw new AuthError('MAINTENANCE_CONFIRMATION_REQUIRED',409);json(res,200,await backup.maintenance(raw,csrf,input.enabled));return true;}
  const file=path.match(/^\/api\/backups\/([^/]+)$/);
  if(file&&req.method==='DELETE'){json(res,200,await backup.delete(raw,csrf,file[1]));return true;}
  if(file&&req.method==='GET'){const r=await backup.download(raw,file[1]);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':r.bytes,'Content-Disposition':`attachment; filename="${r.filename}"`});try{await pipeline(r.handle.createReadStream({autoClose:false}),res);}finally{await r.handle.close();}return true;}
  return false;
 };
}

import {pipeline} from 'node:stream/promises';
import {AuthError} from '../auth/service.mjs';
export function createApplicationRoutes({auth,dashboard,profile,exports}){
 return async({req,res,path,search,raw,csrf,json,body})=>{
  if(path==='/api/dashboard'&&req.method==='GET'){json(res,200,await dashboard.get(raw));return true;}
  if(path==='/api/costs'&&req.method==='GET'){json(res,200,await dashboard.costs(raw,{cursor:search.get('cursor')}));return true;}
  const notice=path.match(/^\/api\/notifications\/([^/]+)$/);
  if(notice&&req.method==='PATCH'){json(res,200,await dashboard.markRead(raw,csrf,notice[1],await body(req)));return true;}
  if(path==='/api/profile'&&req.method==='GET'){json(res,200,await profile.get(raw));return true;}
  if(path==='/api/profile'&&req.method==='PATCH'){json(res,200,await profile.save(raw,csrf,await body(req)));return true;}
  if(path==='/api/me/avatar'){
   await auth.authorize(raw,{admin:true,write:req.method!=='GET',csrf});
   if(req.method==='GET'){const r=await profile.avatar(raw);res.writeHead(200,{'Content-Type':r.mime});res.end(r.buffer);return true;}
   if(req.method==='DELETE'){json(res,200,await profile.removeAvatar(raw,csrf));return true;}
   if(req.method==='PUT'){let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>5*1024*1024)throw new AuthError('PHOTO_TOO_LARGE',413);chunks.push(chunk);}json(res,200,await profile.setAvatar(raw,csrf,Buffer.concat(chunks),req.headers['content-type']));return true;}
  }
  if(path==='/api/exports'&&req.method==='POST'){await auth.authorize(raw,{admin:true,write:true,csrf});const job=await exports.create(raw,csrf,await body(req,131072));exports.queue(job.id).catch(()=>{});json(res,202,job);return true;}
  const job=path.match(/^\/api\/exports\/([^/]+)(?:\/(download))?$/);
  if(job&&req.method==='GET'){
   if(!job[2]){json(res,200,await exports.status(raw,job[1]));return true;}
   const file=await exports.download(raw,job[1]);res.writeHead(200,{'Content-Type':file.mime,'Content-Length':file.bytes,'Content-Disposition':`attachment; filename="${file.filename}"`});try{await pipeline(file.handle.createReadStream({autoClose:false}),res);}finally{await file.handle.close();}return true;
  }
  return false;
 };
}

export function createCountRoutes({count,auth,photos}){
 return async({req,res,path,search,raw,csrf,json,body})=>{
  if(path==='/api/count/tasks'&&req.method==='GET'){json(res,200,await count.list(raw,{cursor:search.get('cursor')}));return true;}
  if(path==='/api/count/tasks'&&req.method==='POST'){json(res,201,await count.publish(raw,csrf,await body(req,131072)));return true;}
  if(path==='/api/count/reports'&&req.method==='GET'){json(res,200,await count.reports(raw,{trash:search.get('trash')==='true',cursor:search.get('cursor')}));return true;}
  if(path==='/api/count/reports/actions'&&req.method==='POST'){json(res,200,await count.reportAction(raw,csrf,await body(req,131072)));return true;}
  const report=path.match(/^\/api\/count\/reports\/([^/]+)$/);
  if(report&&req.method==='GET'){json(res,200,await count.report(raw,report[1]));return true;}
  const task=path.match(/^\/api\/count\/tasks\/([^/]+)(?:\/(accept|begin|submit|result|events|resolve|photo)(?:\/([^/]+))?)?$/);
  if(!task)return false;const [_,id,action,value]=task;
  if(req.method==='GET'&&!action){json(res,200,await count.detail(raw,id));return true;}
  if(req.method==='DELETE'&&!action){json(res,200,await count.cancel(raw,csrf,id,{remove:true}));return true;}
  if(req.method==='POST'&&action==='accept'){json(res,200,await count.accept(raw,csrf,id));return true;}
  if(req.method==='POST'&&action==='begin'){json(res,200,await count.begin(raw,csrf,id));return true;}
  if(req.method==='POST'&&action==='submit'){json(res,200,await count.submit(raw,csrf,id,await body(req,131072)));return true;}
  if(req.method==='POST'&&!action){json(res,200,await count.cancel(raw,csrf,id));return true;}
  if(req.method==='GET'&&action==='result'){json(res,200,await count.result(raw,id));return true;}
  if(req.method==='GET'&&action==='photo'&&value){await count.photoAllowed(raw,id,value);const image=await photos.get(value);res.writeHead(200,{'Content-Type':image.mime});res.end(image.buffer);return true;}
  if(req.method==='GET'&&action==='resolve'&&value){const a=await auth.authorize(raw,{taskControl:true});json(res,200,await count.resolve(raw,a.csrf,id,{generation:search.get('generation'),token:search.get('token')},value));return true;}
  if(req.method==='GET'&&action==='events'){
   const a=await auth.authorize(raw,{taskControl:true}),run={generation:search.get('generation'),token:search.get('token')};await count.connect(raw,a.csrf,id,run);if(res.destroyed){await count.disconnect(id,run);return true;}
   res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write('data: '+JSON.stringify({ready:true})+'\n\n');let busy=false;
   const timer=setInterval(async()=>{if(busy)return;busy=true;try{await count.heartbeat(raw,a.csrf,id,run);res.write('data: '+JSON.stringify({active:true})+'\n\n');}catch(e){if(!res.destroyed)res.end('data: '+JSON.stringify({error:e.code||'COUNT_RESTART_REQUIRED'})+'\n\n');}finally{busy=false;}},2000);timer.unref();
   res.once('close',()=>{clearInterval(timer);count.disconnect(id,run).catch(()=>{});});return true;
  }
  return false;
 };
}

export function createStockRoutes({stock,cleanup}){
 return async({req,res,path,search,raw,csrf,json,body})=>{
  const clean=path.match(/^\/api\/products\/([^/]+)\/history-cleanup$/);
  if(clean&&req.method==='POST'&&cleanup){json(res,200,await cleanup.clean(raw,csrf,clean[1],await body(req,131072)));return true;}
  const overwrite=path.match(/^\/api\/products\/([^/]+)\/quantity$/);
  if(overwrite&&req.method==='PUT'){json(res,200,await stock.overwriteQuantity(raw,csrf,overwrite[1],await body(req,131072)));return true;}
  if(path==='/api/stock/transactions'&&req.method==='POST'){json(res,200,await stock.commit(raw,csrf,await body(req,131072)));return true;}
  const status=path.match(/^\/api\/stock\/requests\/([^/]+)$/);
  if(status&&req.method==='GET'){json(res,200,await stock.status(raw,status[1]));return true;}
  if(path==='/api/stock/draft'){
   if(req.method==='GET'){json(res,200,await stock.draft(raw));return true;}
   if(req.method==='PUT'){json(res,200,await stock.saveDraft(raw,csrf,await body(req,131072)));return true;}
   if(req.method==='DELETE'){json(res,200,await stock.discardDraft(raw,csrf,await body(req)));return true;}
  }
  const history=path.match(/^\/api\/products\/([^/]+)\/history(?:\/([^/]+))?$/);
  if(history&&req.method==='GET'&&!history[2]){json(res,200,await stock.history(raw,history[1],Object.fromEntries(search)));return true;}
  if(history&&req.method==='PATCH'&&history[2]){json(res,200,await stock.editHistory(raw,csrf,history[1],history[2],await body(req)));return true;}
  return false;
 };
}

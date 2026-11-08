export function createCleanupController({api,storage,confirm,changed=()=>{},updated=()=>{},uuid=()=>crypto.randomUUID()}) {
  const state={ready:false,busy:false,pending:null,missing:false,obsolete:false,error:'',notice:'',owner:null};
  let key,productId,restoreMarker,disposed=false;
  const notify=()=>{if(!disposed)changed({...state});};
  function persist(value){
    if(!storage)throw Error('STORAGE_REQUIRED');
    if(value)storage.setItem(key,JSON.stringify(value));else storage.removeItem(key);
    state.pending=value;
  }
  function report(error){
    const code=error.code||error.message;
    const messages={STORAGE_REQUIRED:'Local storage is unavailable. No cleanup was sent.',LOGIN_REQUIRED:'Sign in again, reopen this product, then verify the pending result.',ADMIN_REQUIRED:'An Administrator account is required.',WAREHOUSE_RESTORED:'This request belongs to an earlier warehouse snapshot. Verify its result before discarding it.',CLEANUP_REQUEST_NOT_FOUND:'No confirmed result was found. Retry the same request, or verify again after the warehouse finishes processing.',HISTORY_PROTECTED_OR_MISSING:'Some selected records are protected or missing. Refresh the history and review the selection.',BACKUP_FAILED:'A verified backup could not be created. Nothing was deleted. Check backup storage, then retry this request.',ADMIN_BACKUP_REQUIRED:'Backup storage needs attention. Open Backups, then retry this request.',MAINTENANCE:'The warehouse is under maintenance. Verify the pending result when maintenance ends.'};
    if(code==='WAREHOUSE_RESTORED')state.obsolete=true;
    state.error=messages[code]||'The result could not be confirmed. Keep this request and verify its result before doing another cleanup.';
  }
  async function failed(error){
    report(error);
    // These responses are issued only after the ledger lookup and a proven rollback.
    // Authentication, transport and idempotency conflicts can never release an unknown request.
    if(['HISTORY_PROTECTED_OR_MISSING','PRODUCT_NOT_FOUND','CLEANUP_CHANGED'].includes(error.code)){
      try{persist(null);await updated({rejected:true});}
      catch{state.error+=' Refresh stock history after checking local storage.';}
    }
  }
  async function finish(result){
    // Remember a confirmed result in memory even if clearing durable storage fails.
    state.notice=result.deleted ? result.deleted+' records deleted after a verified backup. Stock quantity is unchanged.'+(result.hasMore?' More eligible records remain; review and confirm another batch.':'') : 'No eligible records. Nothing was changed.';
    try{persist(null);}catch{state.error='Cleanup is confirmed, but local storage could not be cleared. Verify this request again before continuing.';return;}
    state.missing=false;state.obsolete=false;
    try{await updated(result);}catch{state.error='Cleanup is confirmed. Refresh stock history to see the result.';}
  }
  return {
    state,
    dispose(){disposed=true;},
    async initialize(id,marker){
      productId=id;restoreMarker=marker;state.ready=false;state.error='';notify();
      try{
        const session=await api.session();if(session.user?.role!=='admin')throw Error('ADMIN_REQUIRED');
        state.owner=session.user.id;key='warehouse-pending:'+state.owner+':cleanup';
        const pending=JSON.parse(storage?.getItem(key)||'null');
        if(pending&&(!pending.requestId||!pending.productId||(!pending.ids&&!pending.cutoff)))throw Error('INVALID_PENDING');
        state.pending=pending;state.obsolete=!!pending&&Object.hasOwn(pending,'restoreMarker')&&pending.restoreMarker!==marker;state.missing=false;state.ready=true;
      }catch(error){report(error);}notify();
    },
    async start(data){
      if(!state.ready||state.busy||state.pending)return;
      state.busy=true;state.error='';state.notice='';notify();
      try{
        if(data.ids&&(!data.ids.length||data.ids.length>5000))throw Error('INVALID_ITEMS');
        await confirm('Permanently delete these eligible history records? Records within 168 hours remain protected. A verified backup is required before any deletion.','Review permanent cleanup');
        if(disposed)return;
        await confirm('Confirm permanent deletion again. Current stock quantity will remain unchanged.','Final cleanup confirmation');
        if(disposed)return;
        persist({productId,requestId:uuid(),...data,restoreMarker});notify();
        await finish(await api.clean(productId,state.pending));
      }catch(error){if(error!=='cancel'&&error!=='close')await failed(error);}finally{state.busy=false;notify();}
    },
    async verify(){
      if(!state.ready||state.busy||!state.pending)return;
      state.busy=true;state.error='';state.missing=false;notify();
      try{await finish(await api.status(state.pending.productId,state.pending.requestId));}
      catch(error){state.missing=error.code==='CLEANUP_REQUEST_NOT_FOUND';report(error);}finally{state.busy=false;notify();}
    },
    async retry(){
      if(!state.ready||state.busy||!state.pending||state.pending.productId!==productId||state.obsolete)return;
      state.busy=true;state.error='';state.missing=false;notify();
      try{
        await confirm('Retry the same cleanup request? A confirmed request returns its original result without deleting again.','Retry cleanup');
        if(disposed)return;
        persist(state.pending);await finish(await api.clean(productId,state.pending));
      }catch(error){if(error!=='cancel'&&error!=='close')await failed(error);}finally{state.busy=false;notify();}
    },
    async discardObsolete(){
      if(!state.ready||state.busy||!state.pending||!state.missing||!state.obsolete)return;
      state.busy=true;state.error='';notify();
      try{
        // Recheck immediately before discarding; never erase an unknown or confirmed request.
        try{await finish(await api.status(state.pending.productId,state.pending.requestId));return;}
        catch(error){if(error.code!=='CLEANUP_REQUEST_NOT_FOUND')throw error;}
        await confirm('No result exists in the restored warehouse. Discard only this obsolete local request?','Discard obsolete request');
        await confirm('Confirm discarding this request again. No warehouse history will be deleted.','Final discard confirmation');
        if(disposed)return;
        persist(null);state.missing=false;state.obsolete=false;state.notice='Obsolete local request discarded. Review the restored history before starting a new cleanup.';
      }catch(error){if(error!=='cancel'&&error!=='close')report(error);}finally{state.busy=false;notify();}
    },
  };
}

import {Worker} from 'node:worker_threads';
export function renderInWorker(data,{onStarted}={}){
 let started=Promise.resolve();
 const rendering=new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./render-worker.mjs',import.meta.url),{workerData:data});let finished=false;
  const fail=error=>{if(finished)return;finished=true;worker.terminate();reject(error);};
  worker.on('error',fail);
  worker.on('message',value=>{
   if(value.started){if(onStarted){started=Promise.resolve().then(onStarted);started.catch(fail);}return;}
   if(value.error){fail(Object.assign(Error(value.message),{code:value.error}));return;}
   if(value.done&&!finished){finished=true;resolve();}
  });
  worker.on('exit',code=>{if(!finished)fail(Error('Export worker exited before completing: '+code));});
 });
 return rendering.then(()=>started);
}

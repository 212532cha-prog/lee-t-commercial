import {parentPort,workerData} from 'node:worker_threads';
import {writeXlsx,writePdf} from './render.mjs';
try{
 parentPort.postMessage({started:true});
 if(workerData.format==='pdf')await writePdf(workerData.spool,workerData.target);
 else if(workerData.format==='xlsx')await writeXlsx(workerData.spool,workerData.target,workerData.work);
 else throw Error('INVALID_EXPORT_FORMAT');
 parentPort.postMessage({done:true});
}catch(error){parentPort.postMessage({error:error.code||'EXPORT_GENERATION_FAILED',message:error.code==='EXPORT_FONT_GLYPH_MISSING'?error.message:'Export rendering failed'});}

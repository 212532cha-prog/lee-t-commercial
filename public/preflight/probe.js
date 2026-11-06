const $=id=>document.getElementById(id);
const report={revision:'REQ-20261101',startedAt:new Date().toISOString(),secureContext:window.isSecureContext,cameraApi:!!navigator.mediaDevices?.getUserMedia,serverReachable:false,cameraPermission:false,videoObserved:false,completeScanInputs:0};
let stream=null,generation=0;
function status(id,text,ok){$(id).textContent=text;$(id).className=ok?'ok':'error';}
function stop(){generation++;if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}$('camera').srcObject=null;$('start').disabled=false;}
status('secure',report.secureContext?'安全上下文已启用':'不是安全上下文：先解决受信任 HTTPS',report.secureContext);
fetch('/health',{cache:'no-store'}).then(async r=>{if(!r.ok)throw Error('HTTP');const body=await r.json();if(body.revision!==report.revision||body.productionReady!==false)throw Error('REVISION');report.serverReachable=true;report.serverTime=body.serverTime;status('health','服务器连接正常 · '+body.serverTime,true);}).catch(()=>status('health','连接失败：检查局域网、证书和预检服务。',false));
$('start').addEventListener('click',async()=>{
  stop();const current=++generation;report.cameraPermission=false;report.videoObserved=false;
  if(!report.secureContext||!report.cameraApi){status('camera-status','摄像头API不可用：必须在设备上使用受信任的 HTTPS。',false);return;}
  $('start').disabled=true;
  try{const media=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'}}});
    if(current!==generation){media.getTracks().forEach(t=>t.stop());return;}
    stream=media;report.cameraPermission=true;$('camera').srcObject=media;
    await $('camera').play();
    if(current!==generation)return;
    if(!report.videoObserved)status('camera-status','摄像头已授权，等待实际视频帧…',false);
  }catch(error){if(current!==generation)return;stop();status('camera-status','摄像头测试失败：'+(error.name||'UnknownError')+'。请检查权限、设备占用和证书。',false);}
});
$('camera').addEventListener('loadeddata',()=>{if(stream&&$('camera').videoWidth>0&&$('camera').videoHeight>0){report.videoObserved=true;status('camera-status','已观察到本地视频帧。请现场确认画面后停止摄像头。',true);}});
$('stop').addEventListener('click',()=>{stop();status('camera-status','摄像头已停止。先前测试结果保留在本机记录中。',true);});
window.addEventListener('pagehide',stop);
$('scan').addEventListener('keydown',event=>{if(event.key!=='Enter')return;event.preventDefault();const value=$('scan').value.trim();if(!value)return;report.completeScanInputs++;status('scan-status',`已收到 ${report.completeScanInputs} 次完整输入（最近长度 ${value.length}）；未提交库存。`,true);$('scan').value='';});
$('download').addEventListener('click',()=>{const result={...report,completedAt:new Date().toISOString(),cameraPassed:report.secureContext&&report.cameraApi&&report.cameraPermission&&report.videoObserved,scope:'diagnostic-only; not full scan or production acceptance'};const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='warehouse-stage0-probe.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});

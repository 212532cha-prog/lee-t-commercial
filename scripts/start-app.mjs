import {resolve} from 'node:path';
import {createSecureContext} from 'node:tls';
import {createPool,migrate} from '../src/db/database.mjs';
import {loadSettings,pairingCertificateFingerprint,transport} from '../src/runtime/config.mjs';
import {AuthService} from '../src/auth/service.mjs';
import {createAuthServer} from '../src/auth/http.mjs';
import {CatalogService} from '../src/catalog/service.mjs';
import {PhotoStore} from '../src/catalog/files.mjs';
import {createCatalogRoutes} from '../src/catalog/routes.mjs';
import {StockService} from '../src/stock/service.mjs';
import {HistoryCleanup} from '../src/stock/cleanup.mjs';
import {createStockRoutes} from '../src/stock/routes.mjs';
import {CountService} from '../src/count/service.mjs';
import {createCountRoutes} from '../src/count/routes.mjs';
import {BackupService} from '../src/backup/service.mjs';
import {createBackupRoutes} from '../src/backup/routes.mjs';
import {DashboardService} from '../src/dashboard/service.mjs';
import {ProfileService} from '../src/profile/service.mjs';
import {ExportService} from '../src/export/service.mjs';
import {createApplicationRoutes} from '../src/dashboard/routes.mjs';
import {requireLocalLicense} from '../src/commercial/server-license.mjs';
import {EmployeePairing} from '../src/commercial/employee-pairing.mjs';
import {maintainWarehouseAdvertisement,discoveryConfig} from '../src/commercial/discovery.mjs';
let pool,lease;
try{
 const settings=await loadSettings();
 let pairing;
 if(process.argv.includes('--commercial')){
  let license;
  try{license=await requireLocalLicense(settings);}catch{throw Error('LEE_T_ACTIVATION_REQUIRED');}
  pairing=new EmployeePairing({serverId:license.installationId,origin:settings.PUBLIC_ORIGIN,certificateFingerprint:await pairingCertificateFingerprint(settings)});
 }
 const listener=await transport(settings);if(listener.tls)createSecureContext(listener.tls);
 const discovery=discoveryConfig(settings,pairing,listener);
 if(process.argv.includes('--check-config'))console.log('Protected configuration and TLS material validated; database and device acceptance not executed.');
 else{
  pool=createPool(settings.DATABASE_URL);lease=await pool.connect();const lock=(await lease.query("SELECT pg_try_advisory_lock(hashtextextended(current_database()||'.'||current_schema()||':warehouse-app',0)) AS acquired")).rows[0];if(!lock.acquired)throw Error('ANOTHER_INSTANCE_IS_RUNNING');
  await migrate(pool);const auth=new AuthService(pool,{pairing});await auth.bootstrap(settings.BOOTSTRAP_ADMIN_PASSWORD);
  const dataDir=resolve(settings.DATA_DIR||'data'),backup=new BackupService(pool,auth,dataDir);await backup.startup();
  // A server restart always invalidates unsent counts, while preserving assignment and saved stock drafts.
  await pool.query("UPDATE count_tasks SET run_generation=run_generation+1,channel_open=false,run_token_hash=NULL,execution_session_hash=NULL WHERE status='active'");
  const photos=new PhotoStore(pool,resolve(dataDir,'product-photos'),auth),profile=new ProfileService(pool,auth,dataDir),exporter=new ExportService(pool,auth,dataDir),catalog=new CatalogService(pool,auth),dashboard=new DashboardService(pool,auth),count=new CountService(pool,auth);
  await photos.drain();await profile.drain();await exporter.reap({startup:true});
  const server=createAuthServer({auth,publicOrigin:settings.PUBLIC_ORIGIN,tunnelPublicOrigin:settings.TUNNEL_PUBLIC_ORIGIN,tls:listener.tls,localAdmin:!!pairing?.certificateFingerprint,catalogRoutes:createCatalogRoutes({auth,catalog,photos,exporter}),stockRoutes:createStockRoutes({stock:new StockService(pool,auth),cleanup:new HistoryCleanup(pool,auth,backup)}),backupRoutes:createBackupRoutes({backup,afterRestore:()=>exporter.reap({startup:true})}),countRoutes:createCountRoutes({count,auth,photos}),applicationRoutes:createApplicationRoutes({auth,dashboard,profile,exports:exporter})});
  let advertisement;
  let stopping=false;const housekeeping=new Set();
  const maintain=fn=>{const operation=fn();housekeeping.add(operation);operation.catch(()=>console.error('Background operation needs administrator review.')).finally(()=>housekeeping.delete(operation));};
  const timer=setInterval(()=>maintain(()=>backup.scheduled()),60000),cleanupTimer=setInterval(()=>maintain(()=>exporter.reap()),60000);timer.unref();cleanupTimer.unref();
  const stop=async()=>{if(stopping)return;stopping=true;clearInterval(timer);clearInterval(cleanupTimer);server.closeStreams();const closed=new Promise(r=>server.close(r));server.closeIdleConnections();const force=setTimeout(()=>server.closeAllConnections(),15000);force.unref();await closed;clearTimeout(force);if(advertisement)await advertisement.close();await Promise.allSettled([...housekeeping]);await backup.waitForIdle();await exporter.tail;lease.release();lease=null;await pool.end();pool=null;if(process.stdin.isTTY)process.stdin.pause();else process.stdin.destroy();console.log('Warehouse stopped cleanly.');};
  for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>stop().catch(()=>{console.error('Shutdown failed; inspect database and backup state before restart.');process.exitCode=1;}));
  if(!process.stdin.isTTY){process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',chunk=>{input+=chunk;if(input.length>1024)input='';let end;while((end=input.indexOf('\n'))>=0){const line=input.slice(0,end).trim();input=input.slice(end+1);if(line==='shutdown')stop().catch(()=>{process.exitCode=1;});}});}
  server.listen(listener.port,listener.bind,()=>{
   if(discovery){
    const warn=()=>console.error('mDNS unavailable. Use the configured HTTPS address and check LAN multicast.');
    try{advertisement=maintainWarehouseAdvertisement(discovery,{onError:warn});}catch{warn();}
   }
   console.log('Warehouse ready. '+(listener.tls?'Direct HTTPS listener active.':'Loopback HTTP listener requires the trusted HTTPS reverse proxy.'));maintain(()=>backup.scheduled());});
  server.on('error',()=>{console.error('Warehouse listener failed.');stop().catch(()=>{process.exitCode=1;});process.exitCode=1;});
 }
}catch(error){
 if(error.message==='ANOTHER_INSTANCE_IS_RUNNING')console.error('Startup refused: this database already has a running warehouse instance.');
 else if(error.message==='LEE_T_ACTIVATION_REQUIRED')console.error('Lee T commercial startup requires a valid license for this installation and version.');
 else console.error('Startup failed: check protected database/origin/TLS/bootstrap configuration and verified recovery state. No demo fallback.');
 if(lease)lease.release();
 if(pool)await pool.end();
 process.exitCode=1;
}

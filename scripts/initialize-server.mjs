import {loadSettings} from '../src/runtime/config.mjs';
import {createPool,migrate} from '../src/db/database.mjs';
import {BackupService} from '../src/backup/service.mjs';
import {resolve} from 'node:path';
import {AuthService,defaultAdministratorUsername} from '../src/auth/service.mjs';
let pool;
try{
 const settings=await loadSettings();const address=new URL(settings.DATABASE_URL).hostname;if(!['127.0.0.1','localhost','[::1]','::1'].includes(address))throw Error('LOCAL_DATABASE_REQUIRED');pool=createPool(settings.DATABASE_URL);if(process.argv.includes('--require-local-listener')){const version=Number((await pool.query('SHOW server_version_num')).rows[0].server_version_num);if(version<170000||version>=180000)throw Error('POSTGRESQL_17_REQUIRED');const listener=(await pool.query('SHOW listen_addresses')).rows[0].listen_addresses.split(',').map(s=>s.trim());if(listener.some(host=>!['localhost','127.0.0.1','::1'].includes(host)))throw Error('LOOPBACK_LISTENER_REQUIRED');}await migrate(pool);let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>16384)throw Error('INPUT_TOO_LARGE');}
 const input=JSON.parse(text),auth=new AuthService(pool);
 const username=input.initialUsername===undefined?defaultAdministratorUsername:input.initialUsername;
 const result=await auth.bootstrap(input.initialPassword,{username,displayName:input.initialDisplayName});
 if(result.created&&input.backupPath1&&input.backupPath2){
  const admin=await auth.login(username,input.initialPassword);
  try{await new BackupService(pool,auth,resolve(settings.DATA_DIR||'data')).configure(admin.token,admin.csrf,{path1:input.backupPath1,path2:input.backupPath2});}
  finally{await auth.logout(admin.token);}
 }
 console.log(result.created?'Initial administrator created.':'Existing administrator preserved; no credential reset.');
}catch{console.error('Initialization failed. Check protected database configuration and password input.');process.exitCode=1;}
finally{if(pool)await pool.end();}

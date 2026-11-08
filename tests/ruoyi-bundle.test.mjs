import test from 'node:test';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sealRuoyiBundle,verifyRuoyiBundle} from '../scripts/verify-ruoyi-bundle.mjs';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'leet-bundle-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(join(dir,'static/js'),{recursive:true});await mkdir(join(dir,'static/css'));
 for(const [path,content] of Object.entries({'index.html':'<title>LEE T Administration</title><script type="module" src="/admin/static/js/app-test.js"></script><link rel="stylesheet" href="/admin/static/css/app-test.css">','static/js/app-test.js':'console.log("LEE T");','static/css/app-test.css':'body{color:#334155}','RuoYi-LICENSE.txt':'MIT test fixture','jsQR-LICENSE.txt':'Apache test fixture'}))await writeFile(join(dir,path),content);
 return dir;
}
test('a sealed management bundle verifies exact offline assets and retained license files',async t=>{
 const dir=await fixture(t),first=await sealRuoyiBundle(dir);assert.equal(first.files.length,5);assert.deepEqual(await verifyRuoyiBundle(dir),first);await assert.rejects(sealRuoyiBundle(dir),e=>e.code==='EEXIST');
});
test('changed, missing and unexpected files cannot pass management verification',async t=>{
 for(const kind of ['changed','missing','extra','license']){
  const dir=await fixture(t);await sealRuoyiBundle(dir);
  if(kind==='changed')await writeFile(join(dir,'static/js/app-test.js'),'tampered');
  if(kind==='missing')await rm(join(dir,'static/css/app-test.css'));
  if(kind==='extra')await writeFile(join(dir,'private.json'),'not allowed');
  if(kind==='license')await rm(join(dir,'RuoYi-LICENSE.txt'));
  await assert.rejects(verifyRuoyiBundle(dir));
 }
});
test('external or traversing entry assets, invalid manifests and symlinks are rejected',async t=>{
 for(const source of ['https://example.invalid/app.js','/admin/static/js/../../private.js','/static/js/app.js']){
  const dir=await fixture(t),html=await readFile(join(dir,'index.html'),'utf8');await writeFile(join(dir,'index.html'),html.replace('/admin/static/js/app-test.js',source));await assert.rejects(sealRuoyiBundle(dir),/INVALID_MANAGEMENT_ENTRY/);
 }
 const dir=await fixture(t);await sealRuoyiBundle(dir);await writeFile(join(dir,'bundle-manifest.json'),'{}');await assert.rejects(verifyRuoyiBundle(dir),/MANAGEMENT_BUNDLE_CHANGED/);
 // Linux development and CI check link rejection; Windows uses signed staged ordinary files.
 const links=await fixture(t);await rm(join(links,'static/js/app-test.js'));await symlink(join(links,'index.html'),join(links,'static/js/app-test.js'));await assert.rejects(sealRuoyiBundle(links),/MANAGEMENT_SYMLINK/);
});

test('startup validates the configured management bundle before database access and fails closed on tampering',async t=>{
 const dir=await fixture(t);await sealRuoyiBundle(dir);
 const env={...process.env,DATABASE_URL:'postgresql://127.0.0.1:1/unused',PUBLIC_ORIGIN:'https://localhost',APP_BIND:'127.0.0.1',LEE_T_RUOYI_ADMIN_DIR:dir};
 for(const key of ['WAREHOUSE_CONFIG_PATH','TLS_CERT_PATH','TLS_KEY_PATH','TLS_PFX_PATH','TLS_PFX_PASSPHRASE','LEE_T_MDNS','LEE_T_PAIRING_CERT_PATH','TUNNEL_PUBLIC_ORIGIN'])delete env[key];
 const run=()=>spawnSync(process.execPath,['scripts/start-app.mjs','--check-config'],{env,encoding:'utf8',timeout:15000});
 const valid=run();assert.equal(valid.status,0,valid.stderr);assert.match(valid.stdout,/configuration and TLS material validated/);
 await writeFile(join(dir,'static/js/app-test.js'),'changed after staging');const rejected=run();assert.equal(rejected.status,1);assert.match(rejected.stderr,/Startup failed/);assert.ok(!rejected.stdout.includes('validated'));
});

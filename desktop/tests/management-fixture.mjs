import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {testPool} from '../../tests/helpers/database.mjs';
import {migrate} from '../../src/db/database.mjs';
import {AuthService} from '../../src/auth/service.mjs';
import {createAuthServer} from '../../src/auth/http.mjs';
import {EmployeePairing} from '../../src/commercial/employee-pairing.mjs';
import {CatalogService,UNASSIGNED} from '../../src/catalog/service.mjs';
import {PhotoStore} from '../../src/catalog/files.mjs';
import {createCatalogRoutes} from '../../src/catalog/routes.mjs';
import {StockService} from '../../src/stock/service.mjs';
import {HistoryCleanup} from '../../src/stock/cleanup.mjs';
import {createStockRoutes} from '../../src/stock/routes.mjs';
import {BackupService} from '../../src/backup/service.mjs';
import {createBackupRoutes} from '../../src/backup/routes.mjs';
import {CountService} from '../../src/count/service.mjs';
import {createCountRoutes} from '../../src/count/routes.mjs';
import {DashboardService} from '../../src/dashboard/service.mjs';
import {ProfileService} from '../../src/profile/service.mjs';
import {ExportService} from '../../src/export/service.mjs';
import {createApplicationRoutes} from '../../src/dashboard/routes.mjs';
import {verifyRuoyiBundle} from '../../scripts/verify-ruoyi-bundle.mjs';
if(process.env.WAREHOUSE_NATIVE_PG!=='1')throw Error('Native PostgreSQL is mandatory for the desktop management test.');
const management=process.env.LEET_DESKTOP_TEST_RUOYI_DIR,data=join(process.env.LEET_DESKTOP_TEST_ROOT,'data'),a=join(process.env.LEET_DESKTOP_TEST_ROOT,'primary'),b=join(process.env.LEET_DESKTOP_TEST_ROOT,'fallback');
await verifyRuoyiBundle(management);await Promise.all([data,a,b].map(path=>mkdir(path,{recursive:true})));
const {pool}=await testPool();await migrate(pool);
const certificate=new X509Certificate(await readFile(process.env.LEET_DESKTOP_TEST_CERT));
const pairing=new EmployeePairing({serverId:'52915b2e-2506-43eb-838e-195ac2915b8e',origin:'https://localhost:3443',certificateFingerprint:certificate.fingerprint256.replaceAll(':','').toLowerCase()});
const auth=new AuthService(pool,{pairing});await auth.bootstrap(process.env.LEET_DESKTOP_TEST_PASSWORD);
const actor=await auth.login('CTL LEE',process.env.LEET_DESKTOP_TEST_PASSWORD),seed=new CatalogService(pool),stock=new StockService(pool,auth),category=await seed.addMaster('categories',{name:'Desktop parts'});
const product=await seed.create({name:'Desktop test bolt',categoryId:category.id,locationId:UNASSIGNED,individualCost:'2.50',minimumStock:0,supplierIds:[]});
await stock.commit(actor.token,actor.csrf,{requestId:'4ffad8c3-90fc-4637-a235-a679b309126b',kind:'inbound',items:[{productId:product.id,quantity:7}]});
const backup=new BackupService(pool,auth,data);await backup.configure(actor.token,actor.csrf,{path1:a,path2:b});
const photos=new PhotoStore(pool,join(data,'product-photos'),auth),profile=new ProfileService(pool,auth,data),exporter=new ExportService(pool,auth,data);
const server=createAuthServer({auth,publicOrigin:'https://localhost:3443',ruoyiAdminDirectory:management,
 tls:{pfx:await readFile(process.env.LEET_DESKTOP_TEST_PFX),passphrase:process.env.LEET_DESKTOP_TEST_PASSPHRASE},
 catalogRoutes:createCatalogRoutes({auth,catalog:new CatalogService(pool,auth),photos,exporter}),
 stockRoutes:createStockRoutes({stock,cleanup:new HistoryCleanup(pool,auth,backup)}),backupRoutes:createBackupRoutes({backup}),
 countRoutes:createCountRoutes({auth,count:new CountService(pool,auth),photos}),
 applicationRoutes:createApplicationRoutes({auth,dashboard:new DashboardService(pool,auth),profile,exports:exporter}),
});
// Keep the original service-not-ready/retry assertion while rendering the real built workspace.
let ready=false;const handler=server.listeners('request')[0];server.removeAllListeners('request');
server.on('request',(req,res)=>{
 if(req.url==='/ready'&&req.method==='POST'){ready=true;res.end('ready');return;}
 if(req.url==='/api/commercial/server-identity'&&!ready){res.writeHead(503,{'Content-Type':'application/json'});res.end('{"schema":1}');return;}
 handler(req,res);
});
server.listen(3443,'127.0.0.1');

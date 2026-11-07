import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ExportService } from '../src/export/service.mjs';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testPool } from '../tests/helpers/database.mjs';
import { launchBrowser } from '../tests/helpers/browser.mjs';
import { migrate } from '../src/db/database.mjs';
import { AuthService } from '../src/auth/service.mjs';
import { createAuthServer } from '../src/auth/http.mjs';
import { CatalogService, UNASSIGNED } from '../src/catalog/service.mjs';
import { PhotoStore } from '../src/catalog/files.mjs';
import { createCatalogRoutes } from '../src/catalog/routes.mjs';
import { StockService } from '../src/stock/service.mjs';
import { CountService } from '../src/count/service.mjs';
import { createCountRoutes } from '../src/count/routes.mjs';
import { DashboardService } from '../src/dashboard/service.mjs';
import { createApplicationRoutes } from '../src/dashboard/routes.mjs';

if (!process.argv[2]) throw Error('Provide the built RuoYi directory.');
const { pool } = await testPool();
const directory = await mkdtemp(join(tmpdir(), 'leet-ruoyi-browser-'));
let server, proxy, browser, exporter;
try {
  await migrate(pool);
  const auth = new AuthService(pool), catalog = new CatalogService(pool, auth), seed = new CatalogService(pool);
  const password = randomUUID();
  await auth.bootstrap(password);
  await auth.createEmployee({ username: 'staff', realName: 'Count worker', password });
  const category = await seed.addMaster('categories', { name: 'Fasteners' });
  const input = { name: 'Bolt', categoryId: category.id, locationId: UNASSIGNED, individualCost: '1.25', minimumStock: 2, supplierIds: [] };
  const actor = await auth.login('CTL LEE', password);
  const employee = await auth.login('staff', password);
  const first = await seed.create({ ...input, name: 'Bolt A' });
  await seed.create({ ...input, name: 'Bolt B' });
  const stock = new StockService(pool, auth), count = new CountService(pool, auth);
  await stock.commit(actor.token, actor.csrf, { requestId: randomUUID(), kind: 'inbound', items: [{ productId: first.id, quantity: 5 }] });
  const before = await catalog.detail(first.id);
  exporter = new ExportService(pool,auth,directory);
  const task = await count.publish(actor.token,actor.csrf,{title:'Exported count',scope:'all'});
  await count.accept(employee.token,employee.csrf,task.id);
  const run = await count.begin(employee.token,employee.csrf,task.id);
  await count.connect(employee.token,employee.csrf,task.id,run);
  const reportResult = await count.submit(employee.token,employee.csrf,task.id,{...run,requestId:randomUUID(),items:[{productId:first.id,quantity:3},{productId:(await seed.list({limit:100})).products.find(p=>p.id!==first.id).id,quantity:0}]});
  server = createAuthServer({
    auth, publicOrigin: 'https://warehouse.test', ruoyiAdminDirectory: resolve(process.argv[2]),
    catalogRoutes: createCatalogRoutes({ auth, catalog, photos: new PhotoStore(pool, directory, auth) }),
    countRoutes: createCountRoutes({ count, auth }),
    applicationRoutes: createApplicationRoutes({ auth, dashboard: new DashboardService(pool, auth), exports:exporter }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let base;
  // Localhost UI transport only. Production TLS validation is covered by the mandatory TLS suite.
  proxy = createServer((req, res) => {
    const headers = { ...req.headers };
    if (headers.origin === base) headers.origin = 'https://warehouse.test';
    const upstream = request({ host: '127.0.0.1', port: server.address().port, path: req.url, method: req.method, headers }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
      res.on('close', () => response.destroy());
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  base = 'http://localhost:' + proxy.address().port;
  browser = await launchBrowser();
  const errors = [];
  const page = await browser.browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/admin/');
  const login = page.locator('.sign-in-form');
  await login.locator('input[type=text]').fill('CTL LEE');
  await login.locator('input[type=password]').fill(randomUUID());
  await login.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByText('The username or password is incorrect, or the account is inactive.', { exact: true }).waitFor();
  assert.equal(await login.locator('input[type=password]').inputValue(), '');
  await login.locator('input[type=password]').fill(password);
  await login.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Warehouse overview', exact: true }).waitFor();
  await page.getByRole('menuitem',{name:'Stocktakes',exact:true}).click();
  await page.getByRole('button',{name:'Reports',exact:true}).click();
  await page.locator('.el-table__row').filter({hasText:'Exported count'}).getByRole('button',{name:'Export report',exact:true}).click();
  await page.getByText(/Selected count report:/).waitFor();
  async function generate() {
    const response = page.waitForResponse(r=>r.url()===base+'/api/exports' && r.request().method()==='POST');
    await page.getByRole('button',{name:'Generate file',exact:true}).click();
    const result = await response; assert.equal(result.status(),202);
    const job = await result.json();
    const link = page.locator('a.export-download[href="/api/exports/'+job.id+'/download"]');
    await link.waitFor({timeout:30000});
    return {job,link};
  }
  const xlsx = await generate();
  const choices = (await pool.query('SELECT choices FROM export_jobs WHERE id=$1',[xlsx.job.id])).rows[0].choices;
  assert.deepEqual(choices.reportIds,[reportResult.reportId]);
  assert.deepEqual(choices.sections,['reports']);
  const download = page.waitForEvent('download'); await xlsx.link.click();
  const file = await download; assert.match(file.suggestedFilename(),/\.xlsx$/);
  const path = join(directory,'download.xlsx'); await file.saveAs(path);
  const parsed = JSON.parse(execFileSync(process.env.CODEX_PRIMARY_RUNTIME_PYTHON||'python3',['scripts/inspect-xlsx.py',path],{encoding:'utf8'}));
  assert.deepEqual(parsed.sheets.map(sheet=>sheet.name),['Count Reports']);
  assert.ok(JSON.stringify(parsed).includes('Exported count'));
  assert.ok(JSON.stringify(parsed).includes('Bolt A'));
  await page.locator('.el-form-item').filter({has:page.getByRole('combobox',{name:'File format',exact:true})}).locator('.el-select__wrapper').click();
  await page.getByRole('option',{name:'PDF',exact:true}).click();
  const pdf = await generate();
  const pdfDownload = page.waitForEvent('download'); await pdf.link.click();
  const pdfFile = await pdfDownload; assert.match(pdfFile.suggestedFilename(),/\.pdf$/);
  const pdfPath = join(directory,'download.pdf'); await pdfFile.saveAs(pdfPath);
  const text = execFileSync('pdftotext',[pdfPath,'-'],{encoding:'utf8'});
  for (const word of ['Count Reports','Exported count','Bolt A','GMT+8']) assert.ok(text.includes(word),word);
  await pool.query("UPDATE export_jobs SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",[pdf.job.id]);
  await page.getByRole('button',{name:'Check export status',exact:true}).click();
  await page.getByText(/This export expired or was invalidated/).waitFor();
  assert.equal(await page.getByRole('button',{name:'Generate file',exact:true}).isEnabled(),true);
  assert.equal(await page.getByRole('link',{name:'Download file',exact:true}).count(),0);
  assert.equal((await catalog.detail(first.id)).quantity,before.quantity);
  assert.equal((await catalog.detail(first.id)).inventoryVersion,before.inventoryVersion);
  await page.getByRole('menuitem',{name:'Data export',exact:true}).click();
  assert.equal(await page.getByText(/Selected count report:/).count(),0);
  await page.getByLabel('Product inventory',{exact:true}).uncheck();
  await page.getByRole('button',{name:'Generate file',exact:true}).click();
  await page.getByText('Choose a format and at least one data section.',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('Built RuoYi exports: selected report scope, real parsed Excel/PDF downloads, expiry recovery, scope reset, validation and preserved inventory passed.');
} finally {
  if (exporter) await exporter.tail;
  if (browser) { await browser.browser.close(); await browser.cleanup(); }
  for (const instance of [proxy,server]) if (instance) { instance.closeAllConnections(); await new Promise(resolve=>instance.close(resolve)); }
  await pool.end(); await rm(directory,{recursive:true,force:true});
}

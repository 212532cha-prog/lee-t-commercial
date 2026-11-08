import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import jsQR from 'jsqr';
import sharp from 'sharp';
import { createAuthServer } from '../src/auth/http.mjs';
import { AuthService } from '../src/auth/service.mjs';
import { EmployeePairing } from '../src/commercial/employee-pairing.mjs';
import { migrate } from '../src/db/database.mjs';
import { testPool } from './helpers/database.mjs';

test('commercial QR enrollment verifies employees, binds one device and revokes old sessions', async t => {
  const { pool } = await testPool();
  let server;
  t.after(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await pool.end();
  });
  await migrate(pool);
  const origin = 'https://warehouse.test';
  const certificateFingerprint = 'ab'.repeat(32);
  const pairing = new EmployeePairing({ origin, serverId: randomUUID(), certificateFingerprint });
  const internalAuth = new AuthService(pool);
  const adminSecret = randomUUID();
  await internalAuth.bootstrap(adminSecret);
  const employee = { username: 'employee-a', realName: 'Employee A', password: randomUUID() };
  const { id } = await internalAuth.createEmployee(employee);
  const other = { username: 'employee-b', realName: 'Employee B', password: randomUUID() };
  await internalAuth.createEmployee(other);
  const old = await internalAuth.login(employee.username, employee.password);
  const auth = new AuthService(pool, { pairing });
  const admin = await auth.login('CTL LEE', adminSecret);
  server = createAuthServer({ auth, publicOrigin: origin });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const sessionCookie = token => `__Host-warehouse_session=${token}`;
  const request = async (path, { data, cookie = '', csrf = '' } = {}) => {
    const response = await fetch(endpoint + path, {
      method: data ? 'POST' : 'GET',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, body: await response.json(), cookies: response.headers.getSetCookie() };
  };
  const login = (data, cookie) => request('/api/auth/login', { data, cookie });
  const me = cookie => request('/api/me', { cookie });
  const manage = (action, cookie = sessionCookie(admin.token), csrf = admin.csrf) =>
    request(`/api/employees/${id}/pairing/${action}`, { data: {}, cookie, csrf });

  assert.equal((await me(sessionCookie(old.token))).status, 401);
  assert.equal((await login(employee)).body.error, 'EMPLOYEE_PAIRING_REQUIRED');
  assert.equal((await manage('invite', '', '')).status, 401);
  assert.equal((await manage('invite', sessionCookie(admin.token), 'bad')).status, 403);
  const configPath = '/api/commercial/diagnostic-config';
  assert.equal((await request(configPath)).status, 401);
  const config = await request(configPath, { cookie: sessionCookie(admin.token) });
  assert.equal(config.status, 200);
  assert.deepEqual(config.body, { serverId: pairing.serverId, origin });
  const expired = await manage('invite');
  await pool.query("UPDATE employee_pairing_invites SET expires_at=now()-interval '1 second'");
  assert.equal((await login({ ...employee, invitation: expired.body.invitation })).status, 403);
  const issued = await manage('invite');
  assert.equal(issued.status, 201);
  const { data: pixels, info } = await sharp(Buffer.from(issued.body.qrPng, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const decoded = new URL(jsQR(new Uint8ClampedArray(pixels), info.width, info.height).data);
  assert.equal(decoded.origin, origin);
  const invitation = JSON.parse(decodeURIComponent(decoded.hash.slice('#pairing='.length)));
  assert.deepEqual(invitation, issued.body.invitation);
  assert.equal(invitation.certificateFingerprint, certificateFingerprint);
  assert.equal((await login({ ...other, invitation })).status, 403);
  assert.equal((await login({ ...employee, password: randomUUID(), invitation })).status, 401);
  assert.equal((await login({ ...employee, invitation: { ...invitation, serverId: randomUUID() } })).status, 403);

  const results = await Promise.all([login({ ...employee, invitation }), login({ ...employee, invitation })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 403]);
  const paired = results.find(result => result.status === 200);
  const browserCookies = paired.cookies.map(value => value.split(';')[0]);
  const device = browserCookies.find(value => value.startsWith('__Host-leet_device='));
  assert.match(paired.cookies.find(value => value.startsWith(device)), /Secure; HttpOnly; SameSite=Strict/);
  assert.equal(paired.body.deviceToken, undefined);
  assert.equal((await me(browserCookies.join('; '))).status, 200);
  assert.equal((await me(browserCookies.find(value => value.startsWith('__Host-warehouse_session=')))).status, 401);
  assert.equal((await manage('unbind', browserCookies.join('; '), paired.body.csrf)).status, 403);
  assert.equal((await request(configPath, { cookie: browserCookies.join('; ') })).status, 403);
  assert.equal((await manage('invite')).body.error, 'EMPLOYEE_ALREADY_PAIRED');
  assert.equal((await login(employee)).body.error, 'EMPLOYEE_DEVICE_NOT_AUTHORIZED');
  assert.equal((await login(employee, device)).status, 200);
  assert.equal((await manage('signout')).status, 200);
  assert.equal((await me(browserCookies.join('; '))).status, 401);
  const signedIn = await login(employee, device);
  assert.equal(signedIn.status, 200);
  assert.equal((await manage('unbind')).status, 200);
  assert.equal((await me(signedIn.cookies[0].split(';')[0])).status, 401);
  assert.equal((await login({ ...employee, invitation }, device)).status, 403);
  const replacement = await manage('invite');
  assert.equal((await login({ ...employee, invitation: replacement.body.invitation })).status, 200);
  const audit = (await pool.query('SELECT action FROM employee_pairing_audit')).rows.map(row => row.action);
  assert.deepEqual(audit.sort(), ['bound', 'bound', 'invited', 'invited', 'invited', 'signed_out', 'unbound']);
});

test('pre-pairing archives restore business data and clear local device credentials', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { metadata, restoreRows, snapshot, validateArchive } = await import('../src/backup/archive.mjs');
  const { transaction } = await import('../src/db/database.mjs');
  const { pool } = await testPool();
  const directory = await mkdtemp(join(tmpdir(), 'leet-legacy-backup-'));
  t.after(async () => {
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  });
  await migrate(pool);
  const auth = new AuthService(pool);
  const adminPassword = randomUUID();
  await auth.bootstrap(adminPassword);
  const { id } = await auth.createEmployee({ username: 'retained', realName: 'Retained employee', password: randomUUID() });
  const path = join(directory, 'before-pairing.whb');
  const beforeRename = join(directory, 'before-rename.whb');
  await pool.query("UPDATE users SET real_name='Chai Lee Tzar' WHERE role='admin'");
  // Recreate the pre-10 constraint and migration ledger before taking genuine 8/7 snapshots.
  await pool.query('ALTER TABLE inventory_cleanup_requests DROP CONSTRAINT cleanup_result_valid; ALTER TABLE inventory_cleanup_requests ALTER COLUMN backup_id SET NOT NULL');
  await pool.query('DELETE FROM schema_migrations WHERE version>=9');
  await snapshot(pool, beforeRename, directory);
  // Version 8 changes only tables absent from the old archive format.
  await pool.query('DELETE FROM schema_migrations WHERE version=8');
  await snapshot(pool, path, directory);
  await pool.query('DROP TABLE employee_pairing_invites,employee_device_bindings,employee_pairing_audit; ALTER TABLE sessions DROP COLUMN device_hash');
  await migrate(pool);
  const meta = await metadata(pool);
  await validateArchive(path, meta);
  await validateArchive(beforeRename, meta);
  await assert.rejects(validateArchive(path, { ...meta, migrations: meta.migrations.map(row => row.version === 7 ? { ...row, checksum: 'different' } : row) }), { code: 'BACKUP_VERSION_MISMATCH' });
  await pool.query('INSERT INTO employee_device_bindings(user_id,server_id,token_hash) VALUES ($1,$2,$3)', [id, randomUUID(), 'local-test-digest']);
  await transaction(pool, db => restoreRows(db, path, meta));
  assert.equal((await pool.query('SELECT id FROM users WHERE id=$1', [id])).rows.length, 1);
  assert.equal((await pool.query('SELECT user_id FROM employee_device_bindings')).rows.length, 0);
  assert.equal((await auth.login('CTL LEE', adminPassword)).user.realName, 'Administrator');
});

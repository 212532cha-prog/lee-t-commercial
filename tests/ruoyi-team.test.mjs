import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { testPool } from './helpers/database.mjs';
import { migrate } from '../src/db/database.mjs';
import { AuthService } from '../src/auth/service.mjs';
import { createAuthServer } from '../src/auth/http.mjs';
import { EmployeePairing } from '../src/commercial/employee-pairing.mjs';
import { createTeamClient } from '../integrations/ruoyi-vue3/src/views/leet/team-api.mjs';

test('RuoYi team client preserves profile versions, pairs devices and revokes sessions on employee actions', async t => {
  const { pool } = await testPool();
  let server;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool.end();
  });
  await migrate(pool);
  const pairing = new EmployeePairing({ serverId: randomUUID(), origin: 'https://warehouse.test', certificateFingerprint: 'ab'.repeat(32) });
  const auth = new AuthService(pool, { pairing });
  const administratorPassword = randomUUID();
  await auth.bootstrap(administratorPassword);
  const admin = await auth.login('CTL LEE', administratorPassword);
  server = createAuthServer({ auth, publicOrigin: pairing.origin });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const client = (session, device) => createTeamClient({
    request: (path, options) => fetch('http://127.0.0.1:' + server.address().port + path, {
      ...options, headers: {
        ...options.headers, Origin: pairing.origin,
        ...(session && { Cookie: '__Host-warehouse_session=' + session.token + (device ? '; __Host-leet_device=' + device : '') }),
      },
    }),
  });
  const api = client(admin);
  assert.equal((await api.session()).employeePairing, true);
  const password = randomUUID();
  const employee = await api.save(null, { username: 'ruoyi-worker', realName: 'Worker', password });
  await assert.rejects(api.save(null, { username: employee.username, realName: 'Duplicate', password }), error => error.code === 'USERNAME_EXISTS');
  const changed = await api.save(employee.id, { username: employee.username, realName: 'Changed worker', expectedVersion: employee.profileVersion });
  await assert.rejects(api.save(employee.id, { username: employee.username, realName: 'Stale worker', expectedVersion: employee.profileVersion }), error => error.code === 'PROFILE_VERSION_CONFLICT');
  assert.equal((await api.list())[0].realName, changed.realName);
  const invitation = await api.pairing(employee.id, 'invite');
  assert.deepEqual(Buffer.from(invitation.qrPng, 'base64').subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const first = await auth.login(employee.username, password, { invitation: invitation.invitation });
  const staff = client(first, first.deviceToken);
  assert.equal((await staff.session()).user.id, employee.id);
  await assert.rejects(staff.list(), /ADMIN_REQUIRED/);
  await assert.rejects(staff.disable(employee.id), /ADMIN_REQUIRED/);
  await assert.rejects(staff.pairing(employee.id, 'unbind'), /ADMIN_REQUIRED/);
  await assert.rejects(api.pairing(employee.id, 'invite'), error => error.code === 'EMPLOYEE_ALREADY_PAIRED');
  await api.pairing(employee.id, 'signout');
  await assert.rejects(staff.session(), /LOGIN_REQUIRED/);
  assert.equal(Number((await pool.query('SELECT count(*) FROM employee_device_bindings WHERE user_id=$1', [employee.id])).rows[0].count), 1);
  const second = await auth.login(employee.username, password, { device: first.deviceToken });
  const nextPassword = randomUUID();
  await api.resetPassword(employee.id, nextPassword);
  await assert.rejects(client(second, first.deviceToken).session(), /LOGIN_REQUIRED/);
  await assert.rejects(auth.login(employee.username, password, { device: first.deviceToken }), error => error.code === 'INVALID_CREDENTIALS');
  const third = await auth.login(employee.username, nextPassword, { device: first.deviceToken });
  await api.pairing(employee.id, 'unbind');
  await assert.rejects(client(third, first.deviceToken).session(), /LOGIN_REQUIRED/);
  assert.equal(Number((await pool.query('SELECT count(*) FROM employee_device_bindings WHERE user_id=$1', [employee.id])).rows[0].count), 0);
  const replacementInvite = await api.pairing(employee.id, 'invite');
  const replacement = await auth.login(employee.username, nextPassword, { invitation: replacementInvite.invitation });
  assert.notEqual(replacement.deviceToken, first.deviceToken);
  const taskId = randomUUID();
  await pool.query("INSERT INTO count_tasks(id,title,status,assigned_user_id) VALUES($1,'Unfinished count','active',$2)", [taskId, employee.id]);
  await api.disable(employee.id);
  await assert.rejects(client(replacement, replacement.deviceToken).session(), /LOGIN_REQUIRED/);
  assert.equal((await api.list())[0].active, false);
  const task = (await pool.query('SELECT status,assigned_user_id FROM count_tasks WHERE id=$1', [taskId])).rows[0];
  assert.equal(task.status, 'pending');
  assert.equal(task.assigned_user_id, null);
  await assert.rejects(api.pairing(employee.id, 'invite'), error => error.code === 'EMPLOYEE_INACTIVE');
  await assert.rejects(client(null).list(), /LOGIN_REQUIRED/);
});

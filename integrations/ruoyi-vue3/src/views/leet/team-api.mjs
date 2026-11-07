import { createAdminTransport } from './warehouse-api.mjs';

export function createTeamClient(options = {}) {
  const { read, write } = createAdminTransport(options);
  const employeePath = id => '/api/employees/' + encodeURIComponent(id);
  return {
    session: signal => read('/api/me', { signal }),
    clock: () => read('/api/state'),
    async list(signal) { return (await read('/api/employees', { signal })).employees; },
    async save(id, data) {
      return (await write(id ? employeePath(id) : '/api/employees', { method: id ? 'PATCH' : 'POST', data })).employee;
    },
    resetPassword(id, newPassword) {
      return write(employeePath(id) + '/password', { method: 'POST', data: { newPassword } });
    },
    disable(id) {
      return write(employeePath(id) + '/disable', { method: 'POST', data: {} });
    },
    pairing(id, action) {
      if (!['invite', 'unbind', 'signout'].includes(action)) throw Error('INVALID_PAIRING_ACTION');
      return write(employeePath(id) + '/pairing/' + action, { method: 'POST', data: {} });
    },
  };
}

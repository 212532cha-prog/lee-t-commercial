import { createAdminTransport } from './warehouse-api.mjs';

export function createCountClient(options = {}) {
  const { read, write } = createAdminTransport(options);
  return {
    tasks(cursor, signal) {
      const query = new URLSearchParams();
      if (cursor) query.set('cursor', cursor);
      return read('/api/count/tasks?' + query, { signal });
    },
    task(id, signal) { return read('/api/count/tasks/' + encodeURIComponent(id), { signal }); },
    publish(data) { return write('/api/count/tasks', { method: 'POST', data }); },
    cancel(id, remove = false) {
      return write('/api/count/tasks/' + encodeURIComponent(id), { method: remove ? 'DELETE' : 'POST', data: {} });
    },
    reports(trash, cursor, signal) {
      const query = new URLSearchParams({ trash: String(trash) });
      if (cursor) query.set('cursor', cursor);
      return read('/api/count/reports?' + query, { signal });
    },
    report(id, signal) { return read('/api/count/reports/' + encodeURIComponent(id), { signal }); },
    reportAction(action, ids) {
      return write('/api/count/reports/actions', { method: 'POST', data: { action, ids, ...(action === 'delete' && { confirm: 'delete-count-reports' }) } });
    },
    masters(signal) { return read('/api/master-data', { signal }); },
    products(cursor, signal) {
      const query = new URLSearchParams({ limit: '100' });
      if (cursor) query.set('cursor', cursor);
      return read('/api/products?' + query, { signal });
    },
  };
}

import { createAdminTransport } from './warehouse-api.mjs';

export function createInventoryClient(options = {}) {
  const { read, write } = createAdminTransport(options);
  const productPath = id => '/api/products/' + encodeURIComponent(id);
  return {
    async detail(id, signal) { return (await read(productPath(id), { signal })).product; },
    history(id, { kind, from, to, order = 'newest', cursor, signal } = {}) {
      const query = new URLSearchParams({ limit: '30', order });
      for (const [key, value] of Object.entries({ kind, from, to, cursor })) if (value) query.set(key, value);
      return read(productPath(id) + '/history?' + query, { signal });
    },
    overwrite(id, data) { return write(productPath(id) + '/quantity', { method: 'PUT', data }); },
    correct(id, eventId, data) {
      return write(productPath(id) + '/history/' + encodeURIComponent(eventId), { method: 'PATCH', data });
    },
  };
}

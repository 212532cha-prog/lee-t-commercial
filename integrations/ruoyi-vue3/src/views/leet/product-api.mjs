import { createAdminTransport } from './warehouse-api.mjs';

export function createProductClient(options = {}) {
  const { read, write } = createAdminTransport(options);
  return {
    masters(signal) {
      return read('/api/master-data', { signal });
    },
    list({ categoryId, locationId, cursor, signal } = {}) {
      const query = new URLSearchParams({ limit: '20' });
      for (const [key, value] of Object.entries({ categoryId, locationId, cursor })) if (value) query.set(key, value);
      return read('/api/products?' + query, { signal });
    },
    async detail(id, signal) {
      return (await read('/api/products/' + encodeURIComponent(id), { signal })).product;
    },
    save(id, data) {
      return write('/api/products' + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'PATCH' : 'POST', data });
    },
    saveMaster(kind, id, data) {
      if (!['categories', 'suppliers', 'locations'].includes(kind)) throw Error('INVALID_MASTER_KIND');
      return write('/api/' + kind + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'PATCH' : 'POST', data });
    },
    removeMaster(kind, id) {
      if (!['categories', 'suppliers', 'locations'].includes(kind)) throw Error('INVALID_MASTER_KIND');
      return write('/api/' + kind + '/' + encodeURIComponent(id), { method: 'DELETE' });
    },
    remove(id) {
      return write('/api/products/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'X-Confirm-Permanent': 'delete-product' } });
    },
  };
}

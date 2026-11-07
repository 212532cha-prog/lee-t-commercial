export function createProductClient({ request = globalThis.fetch } = {}) {
  async function read(path, { signal, method = 'GET', data, headers = {} } = {}) {
    const response = await request(path, {
      method, signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json', ...headers, ...(data && { 'Content-Type': 'application/json' }) },
      ...(data && { body: JSON.stringify(data) }),
    });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(response.status === 401 ? 'LOGIN_REQUIRED' : response.status === 403 ? 'ADMIN_REQUIRED' : body.error || 'WAREHOUSE_UNAVAILABLE');
      error.code = body.error;
      throw error;
    }
    return body;
  }

  async function write(path, options) {
    const session = await read('/api/me');
    if (session.user?.role !== 'admin') throw Error('ADMIN_REQUIRED');
    return read(path, { ...options, headers: { ...options.headers, 'X-CSRF-Token': session.csrf } });
  }

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

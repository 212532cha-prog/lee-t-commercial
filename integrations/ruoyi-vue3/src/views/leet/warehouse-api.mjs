export async function loadWarehouseDashboard({ request = globalThis.fetch, signal } = {}) {
  const response = await request('/api/dashboard', {
    credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
    headers: { Accept: 'application/json' },
  });
  if (response.status === 401) throw Error('LOGIN_REQUIRED');
  if (response.status === 403) throw Error('ADMIN_REQUIRED');
  if (!response.ok) throw Error('WAREHOUSE_UNAVAILABLE');
  const dashboard = await response.json();
  if (dashboard?.role !== 'admin') throw Error('ADMIN_REQUIRED');
  return dashboard;
}

export function createAdminTransport({ request = globalThis.fetch } = {}) {
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

  return { read, write };
}

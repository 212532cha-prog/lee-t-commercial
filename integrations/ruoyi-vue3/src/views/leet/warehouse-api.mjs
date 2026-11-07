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

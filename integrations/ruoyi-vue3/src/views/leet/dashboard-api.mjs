import { createAdminTransport } from './warehouse-api.mjs';

export function formatCost(value) {
  const text = String(value ?? '0');
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return '—';
  const [whole, fraction = ''] = text.split('.');
  return 'RM ' + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + fraction.padEnd(2, '0');
}

export function createDashboardClient(options = {}) {
  const { read, write } = createAdminTransport(options);
  return {
    costs(cursor, signal) {
      return read('/api/costs' + (cursor ? '?' + new URLSearchParams({ cursor }) : ''), { signal });
    },
    markRead(id, token) {
      return write('/api/notifications/' + encodeURIComponent(id), { method: 'PATCH', data: { token } });
    },
  };
}

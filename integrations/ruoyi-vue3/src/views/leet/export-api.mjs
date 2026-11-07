import { createAdminTransport } from './warehouse-api.mjs';

export const exportFields = { productCode: 'Product code', name: 'Product name', category: 'Category', location: 'Location', quantity: 'Current quantity', minimumStock: 'Minimum stock', suppliers: 'Suppliers', individualCost: 'Individual cost', value: 'Stock cost', qrToken: 'QR token' };

export function exportInput(form, scope) {
  if (!['xlsx', 'pdf'].includes(form.format) || !form.sections.length) throw Error('Choose a format and at least one data section.');
  if (form.sections.includes('inventory') && !form.fields.length) throw Error('Choose at least one inventory field.');
  if (form.from && form.to && form.from > form.to) throw Error('The start date must not be after the end date.');
  const input = { format: form.format, sections: [...form.sections], fields: [...form.fields] };
  for (const key of ['categoryId', 'locationId', 'kind']) if (form[key]) input[key] = form[key];
  if (form.from) input.from = form.from + 'T00:00:00+08:00';
  if (form.to) input.to = form.to + 'T23:59:59.999+08:00';
  if (form.productIds.length) input.productIds = [...form.productIds];
  if (scope) { input.reportIds = [scope.id]; input.includeTrashed = !!scope.trashed; }
  return input;
}

export function createExportClient(options = {}) {
  const { read, write } = createAdminTransport(options);
  return {
    create(data) { return write('/api/exports', { method: 'POST', data }); },
    status(id, signal) { return read('/api/exports/' + encodeURIComponent(id), { signal }); },
    masters(signal) { return read('/api/master-data', { signal }); },
    products(cursor, signal) { return read('/api/products?' + new URLSearchParams({ limit: '100', ...(cursor && { cursor }) }), { signal }); },
  };
}

const $ = id => document.getElementById(id);
const customers = $('customers');
const payments = $('payments');

async function api(path, input) {
  const response = await fetch(path, input ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  } : {});
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  return data;
}

async function refreshCustomer() {
  const customerId = customers.value;
  payments.replaceChildren(new Option('Select a payment', ''));
  $('audit').replaceChildren();
  if (!customerId) return;
  const query = '?customerId=' + encodeURIComponent(customerId);
  const [records, audit] = await Promise.all([api('/api/payments' + query), api('/api/audit' + query)]);
  if (customers.value !== customerId) return;
  for (const record of records) {
    const option = new Option(`${record.receipt_reference} · ${record.kind} · ${record.version} · ${record.status}`, record.id);
    option.disabled = !['confirmed', 'expired'].includes(record.status);
    payments.add(option);
  }
  for (const event of audit) {
    const item = document.createElement('li');
    item.textContent = `${event.happened_at} · ${event.actor} · ${event.action}`;
    $('audit').append(item);
  }
}

async function refreshCustomers(selected = customers.value) {
  const records = await api('/api/customers');
  customers.replaceChildren(new Option('Select a customer', ''));
  for (const record of records) customers.add(new Option(record.company_name, record.id));
  customers.value = selected;
  await refreshCustomer();
}

function showError(error) { $('status').textContent = error.message; }
customers.addEventListener('change', () => {
  $('code').textContent = '';
  refreshCustomer().catch(showError);
});
document.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector('button');
  button.disabled = true;
  $('status').textContent = '';
  $('code').textContent = '';
  try {
    const input = Object.fromEntries(new FormData(form));
    if (form.id === 'customer') {
      const customer = await api('/api/customers', input);
      await refreshCustomers(customer.id);
    } else {
      input.customerId = customers.value;
      if (form.id === 'payment') {
        await api('/api/payments', input);
      } else {
        input.expiresAt = new Date(input.expiresAt).toISOString();
        input.request = input.request.trim() ? JSON.parse(input.request) : undefined;
        const { code } = await api('/api/issue', input);
        $('code').textContent = code;
      }
      await refreshCustomer();
    }
    form.reset();
    $('status').textContent = 'Saved.';
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
});
refreshCustomers().catch(showError);

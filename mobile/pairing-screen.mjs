import { launchPairing, resumeWarehouse } from './launcher.mjs';
import { copy } from './pairing-copy.mjs';

export function mountPairingScreen({ document, storage, native, scan, request, requestPinned, discover, open,
  cameraAllowed, openSettings, offlineInventory, clearAdministrator }) {
  const element = id => document.getElementById(id);
  const language = element('language');
  const scanButton = element('scan');
  const resume = element('resume');
  const administrator = element('administrator');
  const administratorScan = element('administrator-scan');
  const offline = element('offline-inventory');
  const forget = element('clear-administrator');
  const settings = element('settings');
  const feedback = element('feedback');
  const keys = { warehouse: 'leet-verified-warehouse', administrator: 'leet-verified-administrator-warehouse', language: 'leet-mobile-language' };
  function read(key) {
    try { return storage.getItem(key); } catch { return null; }
  }
  function save(key, value) {
    try { storage.setItem(key, value); } catch { /* The current screen still works. */ }
  }

  function readWarehouse(key) {
    try {
      const value = JSON.parse(read(key));
      if (typeof value?.origin === 'string' && typeof value.serverId === 'string') return value;
    } catch { /* No saved pairing. */ }
    return null;
  }
  let warehouse = readWarehouse(keys.warehouse);
  let administratorWarehouse = readWarehouse(keys.administrator);
  let locale = read(keys.language);
  if (!Object.hasOwn(copy, locale)) locale = 'en';
  let status = native ? null : 'unsupported';
  let failed = false;
  let busy = false;
  let snapshot = null;

  function renderInventory(words) {
    element('offline-panel').hidden = !snapshot;
    const rows = element('offline-rows');
    rows.replaceChildren();
    if (!snapshot) return;
    element('offline-time').textContent = words.offlineTime + ' ' + new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium', timeStyle: 'short',
    }).format(new Date(snapshot.synchronizedAt));
    for (const [id, label] of Object.entries({
      title: 'offlineTitle', 'read-only': 'offlineReadOnly', code: 'offlineCode', product: 'offlineProduct',
      quantity: 'offlineQuantity', close: 'offlineClose', empty: 'offlineEmpty',
    })) element('offline-' + id).textContent = words[label];
    element('offline-empty').hidden = snapshot.products.length !== 0;
    for (const product of snapshot.products) {
      const row = rows.insertRow();
      for (const value of [product.productCode, product.name, product.quantity]) row.insertCell().textContent = value;
    }
  }

  function render() {
    const words = copy[locale];
    document.documentElement.lang = locale === 'zh' ? 'zh-Hans' : locale;
    language.value = locale;
    for (const id of ['kicker', 'footer']) element(id).textContent = words[id];
    element('title').textContent = words[warehouse ? 'pairedTitle' : 'title'];
    element('description').textContent = words[warehouse ? 'pairedDescription' : 'description'];
    element('steps-title').textContent = words[warehouse ? 'pairedStepsTitle' : 'stepsTitle'];
    element('steps').hidden = !!warehouse;
    element('steps').querySelectorAll('li').forEach((step, i) => { step.textContent = words.steps[i]; });
    resume.hidden = !warehouse;
    resume.textContent = words.resume;
    scanButton.textContent = words[warehouse ? 'rescan' : 'scan'];
    scanButton.className = warehouse ? 'secondary' : 'primary';
    resume.disabled = scanButton.disabled = busy || !native;
    administrator.disabled = administratorScan.disabled = busy || !native;
    administrator.textContent = words.administrator;
    administratorScan.textContent = words.administratorScan;
    administratorScan.hidden = !administratorWarehouse;
    offline.hidden = !administratorWarehouse || !offlineInventory;
    forget.hidden = !administratorWarehouse || !clearAdministrator;
    offline.disabled = forget.disabled = busy || !native;
    offline.textContent = words.offlineTitle;
    forget.textContent = words.offlineForget;
    element('actions').setAttribute('aria-busy', String(busy));
    feedback.hidden = !status;
    feedback.dataset.error = String(failed);
    element('status').textContent = status ? words[status] : '';
    settings.hidden = status !== 'PAIRING_CAMERA_DENIED' || !openSettings;
    settings.textContent = words.settings;
    renderInventory(words);
  }

  function progress(next) {
    status = next;
    render();
  }

  function remember(next) {
    warehouse = next;
    save(keys.warehouse, JSON.stringify(next));
  }

  const connection = { request, requestPinned, discover, open, remember, progress };
  const administratorConnection = { ...connection, remember(next) {
    administratorWarehouse = next;
    save(keys.administrator, JSON.stringify(next));
  } };

  async function run(action) {
    if (busy || !native) return;
    busy = true;
    failed = false;
    snapshot = null;
    const admin = action === 'administrator' || action === 'administrator-scan';
    const needsScan = action === 'scan' || action === 'administrator-scan' || (admin && !administratorWarehouse);
    progress(needsScan ? 'scanning' : 'connecting');
    try {
      if (needsScan) {
        if (cameraAllowed && !await cameraAllowed()) throw Error('PAIRING_CAMERA_DENIED');
        const opened = await launchPairing({ ...(admin ? administratorConnection : connection),
          administrator: admin, scan: () => scan(copy[locale], admin) });
        progress(opened ? null : 'cancelled');
      } else {
        await resumeWarehouse({ ...(admin ? administratorConnection : connection),
          warehouse: admin ? administratorWarehouse : warehouse, administrator: admin });
        progress(null);
      }
    } catch (error) {
      failed = true;
      progress(Object.hasOwn(copy[locale], error?.message) ? error.message : 'fallback');
    } finally {
      busy = false;
      render();
    }
  }

  language.addEventListener('change', () => {
    if (!Object.hasOwn(copy, language.value)) return;
    locale = language.value;
    save(keys.language, locale);
    render();
  });
  scanButton.addEventListener('click', () => run('scan'));
  resume.addEventListener('click', () => run('resume'));
  administrator.addEventListener('click', () => run('administrator'));
  administratorScan.addEventListener('click', () => run('administrator-scan'));
  offline.addEventListener('click', async () => {
    if (busy || !administratorWarehouse) return;
    busy = true;
    snapshot = null;
    failed = false;
    status = null;
    render();
    try {
      const value = await offlineInventory(administratorWarehouse);
      if (Number.isFinite(Date.parse(value?.synchronizedAt)) && Array.isArray(value.products) && value.products.length <= 5000 &&
          value.products.every(product => ['productCode', 'name', 'quantity'].every(key => typeof product?.[key] === 'string'))) {
        snapshot = value;
      }
    } catch { /* No usable encrypted snapshot. */ }
    finally {
      busy = false;
      if (!snapshot) { failed = true; status = 'offlineUnavailable'; }
      render();
    }
  });
  forget.addEventListener('click', async () => {
    if (busy || !administratorWarehouse) return;
    busy = true;
    snapshot = null;
    render();
    try {
      await clearAdministrator(administratorWarehouse);
      failed = false;
      status = 'offlineCleared';
    } catch {
      failed = true;
      status = 'offlineClearFailed';
    } finally {
      busy = false;
      render();
    }
  });
  element('offline-close').addEventListener('click', () => { snapshot = null; render(); });
  settings.addEventListener('click', async () => {
    try { await openSettings(); } catch { /* Permission guidance remains on screen. */ }
  });
  render();
}

import { launchPairing, resumeWarehouse } from './launcher.mjs';
import { copy } from './pairing-copy.mjs';

export function mountPairingScreen({ document, storage, native, scan, request, requestPinned, discover, open,
  cameraAllowed, openSettings }) {
  const element = id => document.getElementById(id);
  const language = element('language');
  const scanButton = element('scan');
  const resume = element('resume');
  const settings = element('settings');
  const feedback = element('feedback');
  const keys = { warehouse: 'leet-verified-warehouse', language: 'leet-mobile-language' };
  function read(key) {
    try { return storage.getItem(key); } catch { return null; }
  }
  function save(key, value) {
    try { storage.setItem(key, value); } catch { /* The current screen still works. */ }
  }

  let warehouse;
  try { warehouse = JSON.parse(read(keys.warehouse)); } catch { /* No saved pairing. */ }
  if (typeof warehouse?.origin !== 'string' || typeof warehouse?.serverId !== 'string') warehouse = null;
  let locale = read(keys.language);
  if (!Object.hasOwn(copy, locale)) locale = 'en';
  let status = native ? null : 'unsupported';
  let failed = false;
  let busy = false;

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
    element('actions').setAttribute('aria-busy', String(busy));
    feedback.hidden = !status;
    feedback.dataset.error = String(failed);
    element('status').textContent = status ? words[status] : '';
    settings.hidden = status !== 'PAIRING_CAMERA_DENIED' || !openSettings;
    settings.textContent = words.settings;
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

  async function run(action) {
    if (busy || !native) return;
    busy = true;
    failed = false;
    progress(action === 'scan' ? 'scanning' : 'connecting');
    try {
      if (action === 'scan') {
        if (cameraAllowed && !await cameraAllowed()) throw Error('PAIRING_CAMERA_DENIED');
        const opened = await launchPairing({ ...connection, scan: () => scan(copy[locale]) });
        progress(opened ? null : 'cancelled');
      } else {
        await resumeWarehouse({ ...connection, warehouse });
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
  settings.addEventListener('click', async () => {
    try { await openSettings(); } catch { /* Permission guidance remains on screen. */ }
  });
  render();
}

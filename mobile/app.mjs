import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { InAppBrowser } from '@capacitor/inappbrowser';
import { launchPairing } from './launcher.mjs';

const button = globalThis.document.querySelector('#scan');
const status = globalThis.document.querySelector('#status');
if (!Capacitor.isNativePlatform()) {
  button.disabled = true;
  status.textContent = 'Open Lee T Mobile on an Android device to scan a pairing code.';
}
button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Scanning…';
  try {
    const opened = await launchPairing({
      scan: () => CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
        scanInstructions: 'Scan the employee pairing QR code from your warehouse administrator.',
      }),
      request: options => CapacitorHttp.get(options),
      open: options => InAppBrowser.openInExternalBrowser(options),
    });
    status.textContent = opened ? 'Continue signing in in your browser.' : 'No QR code was scanned.';
  } catch (error) {
    status.textContent = error.message === 'PAIRING_LINK_EXPIRED'
      ? 'This pairing code has expired. Ask your administrator for a new one.'
      : 'Unable to open the pairing link. Check camera permissions, the local network, and HTTPS trust.';
  } finally {
    button.disabled = false;
  }
});

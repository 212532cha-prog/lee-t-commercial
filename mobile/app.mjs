import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { InAppBrowser } from '@capacitor/inappbrowser';
import { launchPairing } from './launcher.mjs';

const button = globalThis.document.querySelector('#scan');
const status = globalThis.document.querySelector('#status');
const pairingMessages = new Map([
  ['PAIRING_SCAN_FAILED', 'The scanner could not read a code. Check camera permission and try again.'],
  ['INVALID_PAIRING_LINK', 'This is not a valid employee pairing QR code. Ask your administrator for a new one.'],
  ['PAIRING_ORIGIN_MISMATCH', 'The QR code contains conflicting warehouse addresses. Ask your administrator for a new one.'],
  ['PAIRING_LINK_EXPIRED', 'This pairing code has expired. Ask your administrator for a new one.'],
  ['PAIRING_HTTPS_FAILED', 'The app could not connect over HTTPS. Check Wi-Fi and the warehouse CA certificate.'],
  ['PAIRING_SERVER_UNAVAILABLE', 'The warehouse identity endpoint returned an unexpected response.'],
  ['PAIRING_SERVER_MISMATCH', 'The server identity does not match this pairing code. Ask your administrator to check the server.'],
  ['PAIRING_BROWSER_FAILED', 'The warehouse was verified, but the app could not open your browser.'],
]);
if (!Capacitor.isNativePlatform()) {
  button.disabled = true;
  status.textContent = 'Open LEE T Mobile on an Android device to scan a pairing code.';
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
    status.textContent = pairingMessages.get(error?.message) ?? 'Unable to open the pairing link.';
  } finally {
    button.disabled = false;
  }
});

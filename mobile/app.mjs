import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import { mountPairingScreen } from './pairing-screen.mjs';

const workspace = registerPlugin('WarehouseWorkspace');
const android = Capacitor.getPlatform() === 'android';

mountPairingScreen({
  document: globalThis.document,
  storage: globalThis.localStorage,
  native: android,
  scan: (words, administrator) => CapacitorBarcodeScanner.scanBarcode({
    hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
    scanInstructions: administrator ? words.administratorInstructions : words.steps[1],
  }),
  request: options => CapacitorHttp.get(options),
  requestPinned: options => workspace.verifyIdentity(options),
  discover: async options => (await workspace.discover(options)).addresses,
  open: options => workspace.open(options),
  offlineInventory: options => workspace.offlineInventory(options),
  clearAdministrator: options => workspace.clearAdministrator(options),
  cameraAllowed: async () => (await workspace.ensureCamera()).granted,
  openSettings: () => workspace.openSettings(),
});

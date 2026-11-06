import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createDeviceRequest, verifyLicense } from './license.mjs';

const execute = promisify(execFile);
const installationFile = 'installation-id';
const licenseFile = 'license.json';
const version = JSON.parse(await readFile(new URL('../../package.json', import.meta.url))).version;

export async function readWindowsDevice() {
  if (process.platform !== 'win32') throw Error('Windows hardware identification requires Windows.');
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `
    $ErrorActionPreference = 'Stop'
    $machine = Get-ItemPropertyValue 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' MachineGuid
    $board = Get-CimInstance Win32_BaseBoard | Select-Object -First 1
    $disk = Get-Partition -DriveLetter ($env:SystemDrive.Substring(0,1)) | Get-Disk
    @{machineId=$machine; boardId=$board.SerialNumber; systemDiskId=$disk.SerialNumber} | ConvertTo-Json -Compress
  `;
  const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000, windowsHide: true });
  const device = JSON.parse(stdout);
  for (const [field, value] of Object.entries(device)) {
    if (typeof value !== 'string' || /^(?:0+|default string|to be filled by o\.e\.m\.|unknown|none|not specified)?$/i.test(value.trim())) {
      throw Error(`Windows did not provide a stable ${field}.`);
    }
    device[field] = value.trim().toLowerCase();
  }
  return device;
}

function licenseDirectory(settings) {
  if (!settings.LEE_T_LICENSE_DIR) throw Error('LEE_T_LICENSE_DIR is required.');
  return resolve(settings.LEE_T_LICENSE_DIR);
}

async function atomicWrite(target, data, publish) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
  try {
    await publish(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function localActivationRequest(settings, { initialize = false, readDevice = readWindowsDevice } = {}) {
  const directory = licenseDirectory(settings);
  const target = join(directory, installationFile);
  const device = await readDevice();
  if (initialize) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await atomicWrite(target, randomUUID(), link);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const installationId = await readFile(target, 'utf8');
  if (!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(installationId)) throw Error('Invalid Lee T installation identity.');
  return createDeviceRequest({ device, installationId });
}

async function verifyLocalLicense(settings, license, readDevice) {
  if (!settings.LEE_T_ISSUER_PUBLIC_KEY_PATH || !settings.LEE_T_ISSUER_KEY_ID) throw Error('Lee T issuer trust settings are required.');
  const publicKeyPem = await readFile(settings.LEE_T_ISSUER_PUBLIC_KEY_PATH, 'utf8');
  const request = await localActivationRequest(settings, { readDevice });
  const result = verifyLicense({ license, publicKeyPem, request, runningVersion: version, allowedKeyIds: [settings.LEE_T_ISSUER_KEY_ID] });
  if (!result.valid) throw Error(result.reason);
  return { ...result, installationId: request.installationId };
}

export async function installLocalLicense(settings, source, { readDevice } = {}) {
  return storeLocalLicense(settings, JSON.parse(await readFile(source, 'utf8')), { readDevice });
}

export async function storeLocalLicense(settings, license, { readDevice } = {}) {
  const result = await verifyLocalLicense(settings, license, readDevice);
  await atomicWrite(join(licenseDirectory(settings), licenseFile), JSON.stringify(license), rename);
  return result;
}

export async function requireLocalLicense(settings, { readDevice } = {}) {
  const license = JSON.parse(await readFile(join(licenseDirectory(settings), licenseFile), 'utf8'));
  return verifyLocalLicense(settings, license, readDevice);
}

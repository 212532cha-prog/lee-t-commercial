import { readFile } from 'node:fs/promises';
import { findWarehouse, verifyWarehouseAddress } from '../src/commercial/discovery.mjs';

const args = process.argv.slice(2);
const json = args[0] === '--json';
if (json) args.shift();
const [file, address, ...extra] = args;
const report = { checkedAt: new Date().toISOString(), mode: address ? 'manual-ip' : 'mdns', verified: false };

try {
  if (!file || extra.length) throw Error('Usage: node scripts/find-warehouse.mjs [--json] <paired-server.json> [server-ip]');
  const { serverId, origin } = JSON.parse(await readFile(file, 'utf8'));
  const paired = { serverId, origin };
  const result = address
    ? { origin: await verifyWarehouseAddress(paired, address), address }
    : await findWarehouse(paired, { includeAddress: true });
  if (result?.origin) {
    report.verified = true;
    report.origin = result.origin;
    report.address = result.address;
    if (!json) console.log(result.origin);
  } else {
    report.reason = 'NO_MATCHING_TRUSTED_SERVER';
    if (!json) console.error('No matching trusted server found. Check LAN multicast and HTTPS trust, or retry with the server IP.');
  }
} catch (error) {
  report.reason = error instanceof SyntaxError ? 'INVALID_PAIRED_SERVER_JSON' : error.code ?? 'DIAGNOSTIC_ERROR';
  if (!json) console.error(error instanceof SyntaxError ? 'Invalid paired server JSON.' : error.message);
}
if (json) console.log(JSON.stringify(report));
if (!report.verified) process.exitCode = 1;

import { readFile } from 'node:fs/promises';
import { findWarehouse } from '../src/commercial/discovery.mjs';

try {
  const [file, ...extra] = process.argv.slice(2);
  if (!file || extra.length) throw Error('Usage: node scripts/find-warehouse.mjs <paired-server.json>');
  const { serverId, origin } = JSON.parse(await readFile(file, 'utf8'));
  const found = await findWarehouse({ serverId, origin });
  if (found) {
    console.log(found);
  } else {
    console.error('No matching trusted server found. Check the LAN, multicast and HTTPS certificate. Use the originally paired HTTPS address for manual access.');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof SyntaxError ? 'Invalid paired server JSON.' : error.message);
  process.exitCode = 1;
}

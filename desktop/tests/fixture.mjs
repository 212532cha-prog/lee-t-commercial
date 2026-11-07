import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';

let ready = false;
const server = createServer({
  pfx: await readFile(process.env.LEET_DESKTOP_TEST_PFX),
  passphrase: process.env.LEET_DESKTOP_TEST_PASSPHRASE,
}, (req, res) => {
  if (req.url === '/ready' && req.method === 'POST') {
    ready = true;
    res.end('ready');
  } else if (req.url === '/api/commercial/server-identity') {
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ schema: 1, serverId: '52915b2e-2506-43eb-838e-195ac2915b8e' }));
  } else if (req.url === '/session') {
    if (req.method === 'POST') res.setHeader('Set-Cookie', '__Host-smoke=valid; Secure; HttpOnly; SameSite=Strict; Path=/');
    res.end(req.method === 'POST' || req.headers.cookie?.includes('__Host-smoke=valid') ? 'signed-in' : 'signed-out');
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>LEE T desktop fixture</title><h1>LEE T</h1>');
  } else {
    res.writeHead(404).end();
  }
});
server.listen(3443, '127.0.0.1');

import { createServer } from 'node:https';
import { redeemActivationCode } from './activation-ledger.mjs';

import { activationPath } from './activation-client.mjs';
const maxBodyBytes = 4096;

function reply(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

export function createActivationServer({ tls, pool, issuer, onError = () => {} }) {
  if (!tls?.key || !tls.cert || !pool || !issuer?.privateKeyPem || !issuer.keyId) {
    throw Error('HTTPS, issuer and activation database configuration are required.');
  }
  return createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2', requestTimeout: 10000 }, async (request, response) => {
    if (request.url !== activationPath) return reply(response, 404, { error: 'NOT_FOUND' });
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      return reply(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    }
    if (request.headers['content-type'] !== 'application/json') {
      return reply(response, 415, { error: 'JSON_REQUIRED' });
    }
    const chunks = [];
    let bytes = 0;
    let input;
    try {
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > maxBodyBytes) {
          response.setHeader('Connection', 'close');
          return reply(response, 413, { error: 'PAYLOAD_TOO_LARGE' });
        }
        chunks.push(chunk);
      }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid body');
    } catch {
      return reply(response, 400, { error: 'INVALID_REQUEST' });
    }
    try {
      const license = await redeemActivationCode(pool, input, issuer);
      return reply(response, 200, { license });
    } catch (error) {
      if (error.code === 'INVALID_ACTIVATION_CODE') return reply(response, 403, { error: error.code });
      onError();
      return reply(response, 503, { error: 'ACTIVATION_UNAVAILABLE' });
    }
  });
}

import { createServer } from 'node:https';
import {redeemActivationInput,validateActivationIssuer} from './activation-fetch.mjs';

import {activationPath,activationBodyLimit as maxBodyBytes} from './activation-protocol.mjs';

function reply(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

export function createActivationServer({ tls, pool, issuer, onError = () => {} }) {
  if ((!tls?.pfx && (!tls?.key || !tls.cert)) || !pool || !issuer?.privateKeyPem || !issuer.keyId) {
    throw Error('HTTPS, issuer and activation database configuration are required.');
  }
  validateActivationIssuer(issuer);
  const credentials = tls.pfx ? { pfx: tls.pfx, passphrase: tls.passphrase } : { key: tls.key, cert: tls.cert };
  return createServer({ ...credentials, minVersion: 'TLSv1.2', requestTimeout: 10000 }, async (request, response) => {
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
    const result=await redeemActivationInput(pool,input,issuer,onError);
    return reply(response,result.status,result.body);
  });
}

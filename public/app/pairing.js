const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const fragmentPrefix = '#pairing=';
const maximumLength = 4096;

export function parsePairingFragment(fragment, { now = Date.now() } = {}) {
  if (typeof fragment !== 'string' || !fragment.startsWith(fragmentPrefix) || fragment.length > maximumLength) {
    throw Error('INVALID_PAIRING_LINK');
  }
  let invitation, origin;
  try {
    invitation = JSON.parse(decodeURIComponent(fragment.slice(fragmentPrefix.length)));
    origin = new URL(invitation.origin);
  } catch {
    throw Error('INVALID_PAIRING_LINK');
  }
  const { schema, type, serverId, invitationId, token, expiresAt } = invitation;
  if (schema !== 1 || type !== 'leet-local-pairing' || typeof serverId !== 'string' || !uuid.test(serverId) ||
      typeof invitationId !== 'string' || !uuid.test(invitationId) ||
      typeof token !== 'string' || !/^[\w-]{43}$/.test(token) ||
      origin.protocol !== 'https:' || origin.origin !== invitation.origin ||
      typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) {
    throw Error('INVALID_PAIRING_LINK');
  }
  if (Date.parse(expiresAt) <= now) throw Error('PAIRING_LINK_EXPIRED');
  return { schema, type, serverId, invitationId, token, expiresAt, origin: origin.origin };
}

export function parsePairingQr(text, options) {
  if (typeof text !== 'string' || text.length > maximumLength) throw Error('INVALID_PAIRING_LINK');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw Error('INVALID_PAIRING_LINK');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search) {
    throw Error('INVALID_PAIRING_LINK');
  }
  const invitation = parsePairingFragment(url.hash, options);
  if (url.origin !== invitation.origin) throw Error('PAIRING_ORIGIN_MISMATCH');
  return invitation;
}

export async function verifyPairingServer({ origin, serverId }, send = fetch) {
  const endpoint = new URL('/api/commercial/server-identity', origin);
  if (endpoint.protocol !== 'https:' || endpoint.origin !== origin || !uuid.test(serverId)) {
    throw Error('INVALID_PAIRING_LINK');
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 5000);
  try {
    const identity = await send(endpoint, {
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: timeout.signal,
    });
    if (!identity.ok) throw Error('PAIRING_SERVER_UNAVAILABLE');
    const server = await identity.json();
    if (server?.schema !== 1 || server.serverId !== serverId) throw Error('PAIRING_SERVER_MISMATCH');
  } finally {
    clearTimeout(timer);
  }
}

export async function preparePairingSignIn(text, { send = fetch, now = Date.now } = {}) {
  const invitation = parsePairingQr(text, { now: now() });
  await verifyPairingServer(invitation, send);
  if (Date.parse(invitation.expiresAt) <= now()) throw Error('PAIRING_LINK_EXPIRED');
  const signIn = new URL('/', invitation.origin);
  signIn.hash = fragmentPrefix + encodeURIComponent(JSON.stringify(invitation));
  return signIn.href;
}

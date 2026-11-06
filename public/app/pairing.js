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

// Future native launchers can verify the server before opening the warehouse sign-in view.
export async function preparePairingSignIn(text, { send = fetch, now = Date.now } = {}) {
  const invitation = parsePairingQr(text, { now: now() });
  const identity = await send(new URL('/api/commercial/server-identity', invitation.origin), {
    credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
  });
  if (!identity.ok) throw Error('PAIRING_SERVER_UNAVAILABLE');
  const server = await identity.json();
  if (server?.schema !== 1 || server.serverId !== invitation.serverId) throw Error('PAIRING_SERVER_MISMATCH');
  if (Date.parse(invitation.expiresAt) <= now()) throw Error('PAIRING_LINK_EXPIRED');
  const signIn = new URL('/', invitation.origin);
  signIn.hash = fragmentPrefix + encodeURIComponent(JSON.stringify(invitation));
  return signIn.href;
}

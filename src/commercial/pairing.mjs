/** Local pairing primitives. Does not bypass AP isolation or provision HTTPS.
 * Production app must authenticate the employee before activating a device binding.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
const hash = text => createHash('sha256').update(text).digest();
const fail = message => { throw new Error(`Lee T pairing: ${message}`); };
export function makeDiscoveryRecord({ serverId, port, host }) {
 if (typeof serverId !== 'string' || !/^[a-f0-9-]{36}$/.test(serverId)) fail('server UUID required');
 if (!Number.isInteger(port) || port<1 || port>65535) fail('invalid port');
 if (typeof host !== 'string' || !/^[a-z0-9-]{1,63}\.local$/i.test(host)) fail('invalid mDNS host');
 return { service:'_leet-warehouse._tcp',protocol:'tcp',serverId,host,port };
}
export class LocalPairingAuthority {
 #tokens=new Map();
 #serverId;
 #now;
 constructor({serverId=randomUUID(),now=()=>Date.now()}={}) {this.#serverId=serverId;this.#now=now;}
 get serverId(){return this.#serverId;}
 /** QR payload is an ephemeral pairing invitation, never a software license. */
 newInvitation({ttlMs=120000}={}) {
  if(!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>600000) fail('invalid lifetime');
  this.removeExpired();
  const token=randomBytes(32).toString('base64url');
  const invitationId=randomUUID();
  this.#tokens.set(invitationId,{hash:hash(token),expires:this.#now()+ttlMs});
  return {schema:1,type:'leet-local-pairing',serverId:this.#serverId,invitationId,token,expiresAt:this.#now()+ttlMs};
 }
 removeExpired() {for(const [id,record] of this.#tokens) if(record.expires<=this.#now())this.#tokens.delete(id);}
 /** Must be followed by employee authentication and server identity verification. */
 consumeInvitation(invitation) {
  if(!invitation || invitation.serverId!==this.#serverId || invitation.type!=='leet-local-pairing' || typeof invitation.invitationId!=='string' || typeof invitation.token!=='string') return false;
  const saved=this.#tokens.get(invitation.invitationId);
  if(!saved || saved.expires<=this.#now()) {this.#tokens.delete(invitation.invitationId);return false;}
  const attempt=hash(invitation.token);
  if(!timingSafeEqual(saved.hash,attempt))return false;
  this.#tokens.delete(invitation.invitationId);
  return true;
 }
}

import { randomBytes, randomUUID } from 'node:crypto';
import { AuthError, digest, sameToken } from '../auth/service.mjs';
import { transaction } from '../db/database.mjs';

const deviceToken = () => randomBytes(32).toString('base64url');
const validToken = value => typeof value === 'string' && /^[\w-]{43}$/.test(value);
const validId = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const type = 'leet-local-pairing';

async function audit(db, userId, actorId, action) {
  await db.query('INSERT INTO employee_pairing_audit(id,user_id,actor_id,action) VALUES ($1,$2,$3,$4)',
    [randomUUID(), userId, actorId, action]);
}

export class EmployeePairing {
  constructor({ serverId, origin, certificateFingerprint }) {
    if (!validId(serverId) || new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin) {
      throw Error('Pairing requires a server ID and an HTTPS origin.');
    }
    if (certificateFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(certificateFingerprint)) {
      throw Error('Invalid warehouse server certificate fingerprint.');
    }
    this.serverId = serverId;
    this.certificateFingerprint = certificateFingerprint;
    this.origin = origin;
  }

  async manage(auth, context, userId, action) {
    if (!validId(userId)) throw new AuthError('INVALID_ID');
    return transaction(auth.pool, async db => {
      const { user: admin } = await auth.authorizeIn(db, context.raw, {
        admin: true, write: true, csrf: context.csrf,
      });
      const { rows: [employee] } = await db.query(
        "SELECT id,active FROM users WHERE id=$1 AND role='employee' FOR UPDATE", [userId],
      );
      if (!employee) throw new AuthError('EMPLOYEE_NOT_FOUND', 404);
      if (action === 'invite') {
        if (!employee.active) throw new AuthError('EMPLOYEE_INACTIVE', 409);
        if ((await db.query('SELECT 1 FROM employee_device_bindings WHERE user_id=$1', [userId])).rows.length) {
          throw new AuthError('EMPLOYEE_ALREADY_PAIRED', 409);
        }
        const invitationId = randomUUID();
        const token = deviceToken();
        const { rows: [{ expires_at: expiresAt }] } = await db.query(
          `INSERT INTO employee_pairing_invites(user_id,invitation_id,server_id,token_hash,expires_at)
           VALUES($1,$2,$3,$4,clock_timestamp()+interval '2 minutes')
           ON CONFLICT(user_id) DO UPDATE SET invitation_id=excluded.invitation_id,server_id=excluded.server_id,
             token_hash=excluded.token_hash,expires_at=excluded.expires_at
           RETURNING expires_at`, [userId, invitationId, this.serverId, digest(token)],
        );
        await audit(db, userId, admin.id, 'invited');
        return { schema: 1, type, serverId: this.serverId, origin: this.origin, invitationId, token, expiresAt,
          ...(this.certificateFingerprint && { certificateFingerprint: this.certificateFingerprint }) };
      }
      if (action === 'unbind') {
        await db.query('DELETE FROM employee_pairing_invites WHERE user_id=$1', [userId]);
        await db.query('DELETE FROM employee_device_bindings WHERE user_id=$1', [userId]);
      }
      await auth.revokeEmployeeSessionsIn(db, userId);
      await audit(db, userId, admin.id, action === 'unbind' ? 'unbound' : 'signed_out');
      return { ok: true };
    });
  }

  async checkSessionCookie(db, raw, device) {
    const { rows: [session] } = await db.query(
      'SELECT s.device_hash,u.role FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=$1', [digest(raw)],
    );
    if (session?.role === 'employee' && (!validToken(device) || !sameToken(session.device_hash, digest(device)))) {
      throw new AuthError('SESSION_REPLACED_OR_REVOKED', 401);
    }
  }

  async authorizeLogin(db, user, { invitation, device } = {}) {
    const { rows: [binding] } = await db.query(
      'SELECT server_id,token_hash FROM employee_device_bindings WHERE user_id=$1', [user.id],
    );
    if (binding) {
      if (binding.server_id !== this.serverId || !validToken(device) || !sameToken(binding.token_hash, digest(device))) {
        throw new AuthError('EMPLOYEE_DEVICE_NOT_AUTHORIZED', 403);
      }
      return { hash: binding.token_hash };
    }
    if (invitation?.schema !== 1 || invitation.type !== type || invitation.serverId !== this.serverId ||
        invitation.origin !== this.origin || !validId(invitation.invitationId) || !validToken(invitation.token)) {
      throw new AuthError('EMPLOYEE_PAIRING_REQUIRED', 403);
    }
    const { rows: [saved] } = await db.query(
      `SELECT token_hash FROM employee_pairing_invites WHERE user_id=$1 AND invitation_id=$2
       AND server_id=$3 AND expires_at>clock_timestamp()`, [user.id, invitation.invitationId, this.serverId],
    );
    if (!saved || !sameToken(saved.token_hash, digest(invitation.token))) {
      throw new AuthError('EMPLOYEE_PAIRING_REQUIRED', 403);
    }
    const raw = deviceToken();
    const hash = digest(raw);
    await db.query('INSERT INTO employee_device_bindings(user_id,server_id,token_hash) VALUES ($1,$2,$3)',
      [user.id, this.serverId, hash]);
    await db.query('DELETE FROM employee_pairing_invites WHERE user_id=$1', [user.id]);
    await audit(db, user.id, user.id, 'bound');
    return { hash, raw };
  }
}

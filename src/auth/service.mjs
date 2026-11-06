import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {hash,verify,Algorithm} from '@node-rs/argon2';
import {transaction} from '../db/database.mjs';
export class AuthError extends Error{constructor(code,status=400){super(code);this.code=code;this.status=status;}}
export const digest=value=>createHash('sha256').update(value).digest('hex');
const token=()=>randomBytes(32).toString('base64url');
const publicUser=row=>({id:row.id,username:row.username,realName:row.real_name,role:row.role,active:row.active,profileVersion:String(row.profile_version??0),hasAvatar:!!row.avatar_key});
export function validateUsername(value){if(typeof value!=='string')throw new AuthError('INVALID_USERNAME');const s=value.trim();if(!s||s.length>64||/[\u0000-\u001f\u007f]/.test(s))throw new AuthError('INVALID_USERNAME');return s;}
export function validatePassword(value){if(typeof value!=='string'||value.length<6||value.length>128)throw new AuthError('INVALID_PASSWORD');return value;}
function realName(value){if(typeof value!=='string'||!value.trim()||value.trim().length>128)throw new AuthError('INVALID_NAME');return value.trim();}
export const hashPassword=value=>hash(validatePassword(value),{algorithm:Algorithm.Argon2id,memoryCost:19456,timeCost:2,parallelism:1});
export function sameToken(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export class AuthService{
  constructor(pool,{pairing}={}){this.pool=pool;this.pairing=pairing;this.dummyHash=hashPassword(token());}
  async authorizeIn(db,raw,{admin=false,write=false,csrf,sessionOnly=false,backupControl=false,taskControl=false}={}){
    if(typeof raw!=='string'||!raw||raw.length>100)throw new AuthError('UNAUTHENTICATED',401);
    const settings=(await db.query('SELECT maintenance,admin_backup_required FROM system_settings WHERE id=1 FOR SHARE')).rows[0];
    const entry=(await db.query('SELECT user_id FROM sessions WHERE token_hash=$1',[digest(raw)])).rows[0];
    if(!entry)throw new AuthError('SESSION_REPLACED_OR_REVOKED',401);
    const user=(await db.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[entry.user_id])).rows[0];
    const session=(await db.query('SELECT * FROM sessions WHERE token_hash=$1 AND generation=$2',[digest(raw),user.session_generation])).rows[0];
    if(!session||!user.active)throw new AuthError('SESSION_REPLACED_OR_REVOKED',401);
    if(this.pairing&&user.role==='employee'){
      const {rows}=await db.query('SELECT 1 FROM employee_device_bindings WHERE user_id=$1 AND server_id=$2 AND token_hash=$3',[user.id,this.pairing.serverId,session.device_hash]);
      if(!rows.length)throw new AuthError('SESSION_REPLACED_OR_REVOKED',401);
    }
    if(admin&&user.role!=='admin')throw new AuthError('FORBIDDEN',403);
    if(write&&!sameToken(csrf,session.csrf_token))throw new AuthError('CSRF_REQUIRED',403);
    if(!sessionOnly){
      if(settings.admin_backup_required&&user.role==='admin'&&!backupControl)throw new AuthError('ADMIN_BACKUP_REQUIRED',423);
      if(settings.maintenance&&write&&!backupControl)throw new AuthError('MAINTENANCE',503);
      if(user.role==='employee'&&!taskControl&&(await db.query("SELECT id FROM count_tasks WHERE assigned_user_id=$1 AND status='active'",[user.id])).rows.length)throw new AuthError('TASK_IN_PROGRESS',423);
    }
    return {user:publicUser(user),csrf:session.csrf_token};
  }
  async bootstrap(initialPassword){
    return transaction(this.pool,async db=>{
      await db.query('SELECT pg_advisory_xact_lock(20261102)');
      const existing=await db.query("SELECT id FROM users WHERE role = 'admin'");
      if(existing.rows.length)return {created:false};
      const encoded=await hashPassword(initialPassword),id=randomUUID();
      await db.query("INSERT INTO users(id,username,real_name,role,password_hash) VALUES($1,$2,$3,'admin',$4)",[id,'CTL LEE','Chai Lee Tzar',encoded]);
      return {created:true};
    });
  }
  async revokeEmployeeSessionsIn(db,id){
    const changed=await db.query('UPDATE users SET session_generation=session_generation+1 WHERE id=$1 RETURNING session_generation',[id]);
    await db.query('DELETE FROM sessions WHERE user_id=$1',[id]);
    await db.query("UPDATE count_tasks SET run_generation=run_generation+1 WHERE assigned_user_id=$1 AND status='active'",[id]);
    return changed.rows[0].session_generation;
  }
  async login(username,password,pairingInput){
    const name=validateUsername(username);if(typeof password!=='string'||password.length>128)throw new AuthError('INVALID_CREDENTIALS',401);
    const raw=token(),csrf=token();
    return transaction(this.pool,async db=>{
      if(this.pairing)await db.query('SELECT id FROM system_settings WHERE id=1 FOR SHARE');
      const result=await db.query('SELECT * FROM users WHERE username=$1 FOR UPDATE',[name]),user=result.rows[0];
      const valid=await verify(user?.password_hash||await this.dummyHash,password);
      if(!user||!user.active||!valid)throw new AuthError('INVALID_CREDENTIALS',401);
      let device;
      if(user.role==='employee'){
        if(this.pairing)device=await this.pairing.authorizeLogin(db,user,pairingInput);
        user.session_generation=await this.revokeEmployeeSessionsIn(db,user.id);
      }
      await db.query('INSERT INTO sessions(token_hash,user_id,generation,csrf_token,device_hash) VALUES($1,$2,$3,$4,$5)',[digest(raw),user.id,user.session_generation,csrf,device?.hash??null]);
      return {token:raw,csrf,user:publicUser(user),...(device?.raw?{deviceToken:device.raw}:{})};
    });
  }
  async authenticate(raw){
    if(typeof raw!=='string'||!raw||raw.length>100)throw new AuthError('UNAUTHENTICATED',401);
    const r=await this.pool.query('SELECT u.*,s.csrf_token FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND u.active=true AND s.generation=u.session_generation AND ($2::uuid IS NULL OR u.role=\'admin\' OR EXISTS (SELECT 1 FROM employee_device_bindings d WHERE d.user_id=u.id AND d.server_id=$2 AND d.token_hash=s.device_hash))',[digest(raw),this.pairing?.serverId??null]);
    if(!r.rows[0])throw new AuthError('SESSION_REPLACED_OR_REVOKED',401);
    return {user:publicUser(r.rows[0]),csrf:r.rows[0].csrf_token};
  }
  async logout(raw){await this.pool.query('DELETE FROM sessions WHERE token_hash=$1',[digest(raw)]);}
  async adminGuard(db,context){if(context)await this.authorizeIn(db,context.raw,{admin:true,write:true,csrf:context.csrf});}
  async employees(){return (await this.pool.query("SELECT id,username,real_name,role,active,profile_version,avatar_key FROM users WHERE role='employee' ORDER BY username")).rows.map(publicUser);}
  async createEmployee(input,context){
    const name=validateUsername(input.username),full=realName(input.realName),encoded=await hashPassword(input.password),id=randomUUID();
    try{return await transaction(this.pool,async db=>{await this.adminGuard(db,context);const r=await db.query("INSERT INTO users(id,username,real_name,role,password_hash) VALUES($1,$2,$3,'employee',$4) RETURNING id,username,real_name,role,active,profile_version,avatar_key",[id,name,full,encoded]);return publicUser(r.rows[0]);});}
    catch(error){if(error.code==='23505')throw new AuthError('USERNAME_EXISTS',409);throw error;}
  }
  async editEmployee(id,input,context){
    if(context&&input.expectedVersion!==undefined&&(typeof input.expectedVersion!=='string'||!/^\d+$/.test(input.expectedVersion)))throw new AuthError('INVALID_VERSION');
    const name=validateUsername(input.username),full=realName(input.realName);
    try{return await transaction(this.pool,async db=>{await this.adminGuard(db,context);const r=await db.query("UPDATE users SET username=$2,real_name=$3,profile_version=profile_version+1 WHERE id=$1 AND role='employee' AND ($4::bigint IS NULL OR profile_version=$4) RETURNING id,username,real_name,role,active,profile_version,avatar_key",[id,name,full,input.expectedVersion??(context?'0':null)]);if(!r.rows[0]){if((await db.query("SELECT id FROM users WHERE id=$1 AND role='employee'",[id])).rows.length)throw new AuthError('PROFILE_VERSION_CONFLICT',409);throw new AuthError('EMPLOYEE_NOT_FOUND',404);}return publicUser(r.rows[0]);});}
    catch(error){if(error.code==='23505')throw new AuthError('USERNAME_EXISTS',409);throw error;}
  }
  async disableEmployee(id,context){
    await transaction(this.pool,async db=>{
      await this.adminGuard(db,context);const r=await db.query("UPDATE users SET active=false,session_generation=session_generation+1 WHERE id=$1 AND role='employee' RETURNING id",[id]);
      if(!r.rows.length)throw new AuthError('EMPLOYEE_NOT_FOUND',404);
      await db.query('DELETE FROM sessions WHERE user_id=$1',[id]);
      await db.query('DELETE FROM employee_pairing_invites WHERE user_id=$1',[id]);
      await db.query('DELETE FROM employee_device_bindings WHERE user_id=$1',[id]);
      await db.query("UPDATE count_tasks SET status='pending',assigned_user_id=NULL,run_generation=run_generation+1 WHERE assigned_user_id=$1 AND status='active'",[id]);
    });
  }
  async resetEmployeePassword(id,newPassword,context){
    const encoded=await hashPassword(newPassword);
    await transaction(this.pool,async db=>{await this.adminGuard(db,context);const r=await db.query("UPDATE users SET password_hash=$2,session_generation=session_generation+1 WHERE id=$1 AND role='employee' RETURNING id",[id,encoded]);if(!r.rows.length)throw new AuthError('EMPLOYEE_NOT_FOUND',404);await db.query('DELETE FROM sessions WHERE user_id=$1',[id]);});
  }
  async changeAdminPassword(id,oldPassword,newPassword,context){
    const encoded=await hashPassword(newPassword);
    await transaction(this.pool,async db=>{await this.adminGuard(db,context);const r=await db.query("SELECT password_hash FROM users WHERE id=$1 AND role='admin' FOR UPDATE",[id]);if(!r.rows[0]||typeof oldPassword!=='string'||!await verify(r.rows[0].password_hash,oldPassword))throw new AuthError('INVALID_CREDENTIALS',401);await db.query('UPDATE users SET password_hash=$2,session_generation=session_generation+1 WHERE id=$1',[id,encoded]);await db.query('DELETE FROM sessions WHERE user_id=$1',[id]);});
  }
  async recoverAdmin(username,newPassword){
    const name=validateUsername(username),encoded=await hashPassword(newPassword);
    return transaction(this.pool,async db=>{const r=await db.query("UPDATE users SET username=$1,password_hash=$2,session_generation=session_generation+1 WHERE role='admin' RETURNING id",[name,encoded]);if(!r.rows[0])throw new AuthError('ADMIN_NOT_FOUND',404);await db.query('DELETE FROM sessions WHERE user_id=$1',[r.rows[0].id]);return r.rows[0].id;});
  }
  async authorize(raw,{admin=false,write=false,csrf,sessionOnly=false,backupControl=false,taskControl=false}={}){
    const auth=await this.authenticate(raw);
    if(admin&&auth.user.role!=='admin')throw new AuthError('FORBIDDEN',403);
    if(write&&!sameToken(csrf,auth.csrf))throw new AuthError('CSRF_REQUIRED',403);
    if(!sessionOnly){
      const settings=(await this.pool.query('SELECT maintenance,admin_backup_required FROM system_settings WHERE id=1')).rows[0];
      if(settings?.admin_backup_required&&auth.user.role==='admin'&&!backupControl)throw new AuthError('ADMIN_BACKUP_REQUIRED',423);
      if(settings?.maintenance&&write&&!backupControl)throw new AuthError('MAINTENANCE',503);
      if(auth.user.role==='employee'&&!taskControl){
        const task=await this.pool.query("SELECT id FROM count_tasks WHERE assigned_user_id=$1 AND status='active'",[auth.user.id]);
        if(task.rows.length)throw new AuthError('TASK_IN_PROGRESS',423);
      }
    }
    return auth;
  }
}

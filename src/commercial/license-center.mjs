/** Single-process file-backed licensing service for local pilot use.
 * Production multi-instance deployments MUST replace this with a transactional DB,
 * authentication, backup, key management and tamper-evident audit storage.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { issueLicense } from './license.mjs';

const sha = s => createHash('sha256').update(s).digest('hex');
const fail = msg => { throw new Error(`Lee T License Center: ${msg}`); };
const STORE_FORMAT = 1;

export class PilotLicenseCenter {
  #filename;
  #privateKeyPem;
  #keyId;
  #queue = Promise.resolve();
  constructor({ filename, privateKeyPem, keyId }) {
    if (!filename || !privateKeyPem || !keyId) fail('missing configuration');
    this.#filename = filename;this.#privateKeyPem = privateKeyPem;this.#keyId = keyId;
  }
  #serial(work) {
    const task = this.#queue.then(work);
    this.#queue = task.catch(() => {});
    return task;
  }
  async #read() {
    try {
      const data = JSON.parse(await readFile(this.#filename, 'utf8'));
      if (data.schema !== STORE_FORMAT || !Array.isArray(data.codes) || !Array.isArray(data.audit)) fail('invalid store');
      return data;
    } catch (e) {
      if (e.code === 'ENOENT') return { schema: STORE_FORMAT, codes: [], audit: [] };
      throw e;
    }
  }
  async #save(data) {
    await mkdir(dirname(this.#filename), { recursive: true });
    const temporary = `${this.#filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data,null,2), { mode: 0o600, flag: 'wx' });
    await rename(temporary,this.#filename);
  }
  async createActivationCode({ customerId, version, kind='initial', priorLicenseId=null, paid=false }) {
    return this.#serial(async()=>{
      if (!customerId || !/^\d+\.\d+\.\d+$/.test(version)) fail('invalid customer/version');
      if (!['initial','upgrade','transfer'].includes(kind)) fail('invalid code kind');
      if ((kind === 'upgrade' || kind === 'transfer') && !priorLicenseId) fail('missing previous license');
      if (!paid) fail('payment must be confirmed before code issuance');
      const code = `LT-${randomBytes(24).toString('base64url')}`;
      const store=await this.#read();
      store.codes.push({ hash:sha(code), customerId, version, kind, priorLicenseId, redeemed:false, licenseId:null });
      store.audit.push({ event:'code_created',customerId,kind,at:new Date().toISOString() });
      await this.#save(store);
      return code;
    });
  }
  async redeemActivationCode({ code, request }) {
    return this.#serial(async()=>{
      if (typeof code !== 'string' || code.length>100 || !/^LT-[A-Za-z0-9_-]{32}$/.test(code)) fail('invalid code');
      const store=await this.#read();
      const record=store.codes.find(row=>row.hash===sha(code));
      if (!record || record.redeemed) fail('activation code invalid or already redeemed');
      // Do not mark redeemed if the request is malformed or issuance fails.
      const license=issueLicense({ privateKeyPem:this.#privateKeyPem,keyId:this.#keyId,request,
        customerId:record.customerId,kind:record.kind,version:record.version,priorLicenseId:record.priorLicenseId });
      record.redeemed=true;
      record.licenseId=license.payload.licenseId;
      store.audit.push({ event:'code_redeemed',customerId:record.customerId,licenseId:record.licenseId,at:new Date().toISOString() });
      await this.#save(store);
      return license;
    });
  }
  async summary() {
    return this.#serial(async()=>{
      const store=await this.#read();
      return {totalCodes:store.codes.length,redeemed:store.codes.filter(x=>x.redeemed).length,auditEntries:store.audit.length};
    });
  }
}

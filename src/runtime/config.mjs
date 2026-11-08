import {X509Certificate} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const allowed=new Set(['DATABASE_URL','PUBLIC_ORIGIN','TUNNEL_PUBLIC_ORIGIN','DATA_DIR','APP_PORT','APP_BIND','TLS_CERT_PATH','TLS_KEY_PATH','TLS_PFX_PATH','TLS_PFX_PASSPHRASE','LEE_T_LICENSE_DIR','LEE_T_ISSUER_PUBLIC_KEY_PATH','LEE_T_ISSUER_KEY_ID','LEE_T_ACTIVATION_ORIGIN','LEE_T_ACTIVATION_ENDPOINT','LEE_T_MDNS','LEE_T_PAIRING_CERT_PATH','LEE_T_RUOYI_ADMIN_DIR']);
export async function readSettings(environment=process.env){
 const settings={...environment};
 if(environment.WAREHOUSE_CONFIG_PATH){const config=JSON.parse(await readFile(environment.WAREHOUSE_CONFIG_PATH,'utf8'));if(!config.Environment||typeof config.Environment!=='object'||Array.isArray(config.Environment))throw Error('INVALID_SERVER_CONFIGURATION');for(const [key,value]of Object.entries(config.Environment)){if(!allowed.has(key)||typeof value!=='string')throw Error('INVALID_SERVER_CONFIGURATION');if(settings[key]===undefined)settings[key]=value;}}
 return settings;
}
export async function loadSettings(environment=process.env){
 const settings=await readSettings(environment);
 if(!settings.DATABASE_URL||!settings.PUBLIC_ORIGIN)throw Error('DATABASE_URL_AND_PUBLIC_ORIGIN_REQUIRED');
 const origin=new URL(settings.PUBLIC_ORIGIN);if(origin.protocol!=='https:'||origin.origin!==settings.PUBLIC_ORIGIN)throw Error('PUBLIC_ORIGIN_REQUIRES_HTTPS');
 if(settings.TUNNEL_PUBLIC_ORIGIN){
  const tunnel=new URL(settings.TUNNEL_PUBLIC_ORIGIN);
  if(tunnel.protocol!=='https:'||tunnel.origin!==settings.TUNNEL_PUBLIC_ORIGIN)throw Error('TUNNEL_PUBLIC_ORIGIN_REQUIRES_HTTPS');
 }
 return settings;
}
export async function transport(settings){
 const hasPfx=!!settings.TLS_PFX_PATH,hasPem=!!(settings.TLS_CERT_PATH||settings.TLS_KEY_PATH);let tls;
 if(hasPfx&&hasPem)throw Error('CHOOSE_PFX_OR_PEM');
 if(hasPfx)tls={pfx:await readFile(settings.TLS_PFX_PATH),passphrase:settings.TLS_PFX_PASSPHRASE,minVersion:'TLSv1.2'};
 if(hasPem){if(!settings.TLS_CERT_PATH||!settings.TLS_KEY_PATH)throw Error('CERT_AND_KEY_REQUIRED');tls={cert:await readFile(settings.TLS_CERT_PATH),key:await readFile(settings.TLS_KEY_PATH),minVersion:'TLSv1.2'};}
 const port=Number(settings.APP_PORT||(tls?3443:3000)),bind=settings.APP_BIND||'127.0.0.1';if(!Number.isInteger(port)||port<1||port>65535)throw Error('INVALID_APP_PORT');
 if(!tls&&!['127.0.0.1','::1','localhost'].includes(bind))throw Error('PLAINTEXT_LISTENER_MUST_STAY_ON_LOOPBACK');
 if(tls&&Number(new URL(settings.PUBLIC_ORIGIN).port||443)!==port)throw Error('HTTPS_PORT_ORIGIN_MISMATCH');
 return {tls,port,bind};
}

export async function pairingCertificateFingerprint(settings) {
 if(!settings.LEE_T_PAIRING_CERT_PATH)return undefined;
 const certificate=new X509Certificate(await readFile(settings.LEE_T_PAIRING_CERT_PATH));
 if(certificate.ca)throw Error('PAIRING_CERTIFICATE_MUST_BE_SERVER_LEAF');
 return certificate.fingerprint256.replaceAll(':','').toLowerCase();
}

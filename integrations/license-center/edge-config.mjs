export function issuerPoolOptions(environment){
 const input=environment.LEE_T_ISSUER_DATABASE_URL||environment.SUPABASE_DB_URL;
 let url;try{url=new URL(input);}catch{throw Error('ISSUER_DATABASE_CONFIGURATION_REQUIRED');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||!url.password)throw Error('ISSUER_DATABASE_CONFIGURATION_REQUIRED');
 // Connection-string options must never disable TLS or choose a different schema.
 for(const name of [...url.searchParams.keys()])if(/^ssl/i.test(name)||name==='options')url.searchParams.delete(name);
 return {connectionString:url.toString(),max:2,connectionTimeoutMillis:5000,statement_timeout:5000,idleTimeoutMillis:10000,allowExitOnIdle:true,
  ssl:{rejectUnauthorized:true,...(environment.LEE_T_ISSUER_DB_CA&&{ca:environment.LEE_T_ISSUER_DB_CA})},
  options:'-c search_path=lee_t_license',application_name:'lee-t-activation-edge'};
}

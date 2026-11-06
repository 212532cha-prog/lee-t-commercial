import pg from 'pg';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export function createPool(connectionString) {
 if(!connectionString)throw new Error('DATABASE_URL is required; no demo database fallback');
 return new pg.Pool({connectionString,max:12,connectionTimeoutMillis:10000,statement_timeout:15000});
}
export async function transaction(pool,fn){
 const client=await pool.connect();
 try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
 catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function migrate(pool,{directory=new URL('../../migrations/',import.meta.url)}={}){
 const files=(await readdir(directory)).filter(name=>/^\d{3}-[a-z0-9-]+\.sql$/.test(name)).sort();
 const migrations=await Promise.all(files.map(async file=>{const sql=await readFile(new URL(file,directory),'utf8');return {version:Number(file.slice(0,3)),sql,checksum:createHash('sha256').update(sql).digest('hex')};}));
 if(new Set(migrations.map(m=>m.version)).size!==migrations.length)throw Error('DUPLICATE_MIGRATION');
 await transaction(pool,async client=>{
  await client.query('SELECT pg_advisory_xact_lock(20261101)');
  await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY,checksum text)');
  await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text');
  const existing=(await client.query('SELECT version,checksum FROM schema_migrations')).rows;
  if(existing.some(row=>!migrations.some(m=>m.version===row.version)))throw Error('DATABASE_NEWER_THAN_APP');
  for(const migration of migrations){
   const row=existing.find(row=>row.version===migration.version);
   if(row){if(row.checksum&&row.checksum!==migration.checksum)throw Error('MIGRATION_CHANGED');if(!row.checksum)await client.query('UPDATE schema_migrations SET checksum=$2 WHERE version=$1',[migration.version,migration.checksum]);continue;}
   await client.query(migration.sql);
   await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[migration.version,migration.checksum]);
  }
 });
}

import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
export async function testPool(){
 if(process.env.WAREHOUSE_NATIVE_PG==='1'){
  if(!process.env.PGDATABASE?.endsWith('_test'))throw Error('Dedicated *_test database required');
  const admin=new pg.Pool({max:2}),schema='test_'+randomUUID().replaceAll('-','');await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({max:12,options:`-c search_path=${schema}`}),end=pool.end.bind(pool);pool.end=async()=>{try{await end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await admin.end();}};
  return {pool,engine:'native-postgresql'};
 }
 const db=new PGlite();let tail=Promise.resolve();
 const pool={async connect(){let release;const next=new Promise(r=>release=r),previous=tail;tail=next;await previous;return {async query(sql,args){if(!args&&sql.includes(';')){await db.exec(sql);return {rows:[]};}const r=await db.query(sql,args);return {rows:r.rows,rowCount:r.affectedRows};},release};},async query(sql,args){const c=await this.connect();try{return await c.query(sql,args);}finally{c.release();}},async end(){await tail;await db.close();}};
 return {pool,engine:'embedded-postgresql-wasm'};
}

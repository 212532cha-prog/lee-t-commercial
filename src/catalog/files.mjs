import sharp from 'sharp';
import {mkdir,writeFile,unlink,lstat,realpath,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {transaction} from '../db/database.mjs';
import {AuthError} from '../auth/service.mjs';
import {identifier} from './service.mjs';
export const PHOTO_LIMIT=5*1024*1024;
const validKey=key=>typeof key==='string'&&/^[a-f\d-]{36}\.(?:jpg|png)$/.test(key);
export class PhotoStore{
 constructor(pool,directory,auth){this.pool=pool;this.directory=resolve(directory);this.auth=auth;}
 async guard(db,context){if(this.auth){if(!context)throw new AuthError('UNAUTHENTICATED',401);await this.auth.authorizeIn(db,context.raw,{admin:true,write:true,csrf:context.csrf});}await db.query('SELECT pg_advisory_xact_lock_shared(20261131)');}
 async ready(){await mkdir(this.directory,{recursive:true,mode:0o700});return realpath(this.directory);}
 async sanitize(buffer,mime){
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>PHOTO_LIMIT)throw new AuthError('PHOTO_TOO_LARGE',413);
  const png=buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpg=buffer.length>=3&&buffer[0]===255&&buffer[1]===216&&buffer[2]===255;
  if(!((mime==='image/png'&&png)||(mime==='image/jpeg'&&jpg)))throw new AuthError('INVALID_PHOTO',415);
  try{
   const image=sharp(buffer,{limitInputPixels:64000000,failOn:'warning'}).rotate();
   const output=await (png?image.png({compressionLevel:9}):image.jpeg({quality:90})).toBuffer();
   if(output.length>PHOTO_LIMIT)throw new AuthError('PHOTO_TOO_LARGE',413);
   return {buffer:output,extension:png?'png':'jpg'};
  }catch(error){if(error instanceof AuthError)throw error;throw new AuthError('INVALID_PHOTO',415);}
 }
 async drain(){
  const queue=(await this.pool.query('SELECT file_key FROM file_cleanup WHERE asset_kind=\'product\' ORDER BY file_key')).rows;
  let pending=0;
  for(const row of queue){
   if(!validKey(row.file_key)){pending++;continue;}
   try{await transaction(this.pool,async db=>{await db.query('SELECT pg_advisory_xact_lock_shared(20261131)');try{await unlink(resolve(await this.ready(),row.file_key));}catch(e){if(e.code!=='ENOENT')throw e;}await db.query('DELETE FROM file_cleanup WHERE file_key=$1',[row.file_key]);});}
   catch(error){if(error.code==='ENOENT')await this.pool.query('DELETE FROM file_cleanup WHERE file_key=$1',[row.file_key]);else{pending++;await this.pool.query('UPDATE file_cleanup SET attempts=attempts+1 WHERE file_key=$1',[row.file_key]);}}
  }
  return {cleanupPending:pending>0};
 }
 async replace(id,buffer,mime,context){
  identifier(id);const image=await this.sanitize(buffer,mime),key=randomUUID()+'.'+image.extension;
  const dir=await this.ready();await writeFile(resolve(dir,key),image.buffer,{flag:'wx',mode:0o600});
  try{
   await transaction(this.pool,async db=>{
    await this.guard(db,context);const row=(await db.query('SELECT photo_key FROM products WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new AuthError('PRODUCT_NOT_FOUND',404);
    if(row.photo_key)await db.query('INSERT INTO file_cleanup(file_key) VALUES($1) ON CONFLICT DO NOTHING',[row.photo_key]);
    await db.query('UPDATE products SET photo_key=$2,updated_at=clock_timestamp() WHERE id=$1',[id,key]);
   });
  }catch(error){await this.pool.query('INSERT INTO file_cleanup(file_key) VALUES($1) ON CONFLICT DO NOTHING',[key]);await this.drain();throw error;}
  return {updated:true,...await this.drain()};
 }
 async remove(id,context){
  identifier(id);await transaction(this.pool,async db=>{
   await this.guard(db,context);const row=(await db.query('SELECT photo_key FROM products WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new AuthError('PRODUCT_NOT_FOUND',404);
   if(row.photo_key)await db.query('INSERT INTO file_cleanup(file_key) VALUES($1) ON CONFLICT DO NOTHING',[row.photo_key]);
   await db.query('UPDATE products SET photo_key=NULL,updated_at=clock_timestamp() WHERE id=$1',[id]);
  });return {updated:true,...await this.drain()};
 }
 async get(id){
  identifier(id);const row=(await this.pool.query('SELECT photo_key FROM products WHERE id=$1',[id])).rows[0];if(!row)throw new AuthError('PRODUCT_NOT_FOUND',404);
  if(!validKey(row.photo_key))throw new AuthError('PHOTO_NOT_FOUND',404);
  const dir=await this.ready(),path=resolve(dir,row.photo_key);let handle;
  try{
   const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())throw Error('not regular');
   const actual=await realpath(path);if(!actual.startsWith(dir+sep))throw Error('path escape');
   handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
   return {buffer:await handle.readFile(),mime:row.photo_key.endsWith('.png')?'image/png':'image/jpeg'};
  }catch{throw new AuthError('PHOTO_NOT_FOUND',404);}finally{if(handle)await handle.close();}
 }
}

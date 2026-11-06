// Local server operator only: no HTTP endpoint and no credential printed.
import {createPool} from '../src/db/database.mjs';
import {AuthService} from '../src/auth/service.mjs';
let pool;
try{pool=createPool(process.env.DATABASE_URL);const auth=new AuthService(pool);await auth.recoverAdmin(process.env.RECOVERY_ADMIN_USERNAME,process.env.RECOVERY_ADMIN_PASSWORD);console.log('Administrator credentials replaced; existing sessions revoked.');}
catch{console.error('Recovery failed; no password or database URL printed.');process.exitCode=1;}finally{if(pool)await pool.end();}

import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,mkdir,lstat,open,rm} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import yazl from 'yazl';
const root=fileURLToPath(new URL('..',import.meta.url)),version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
const revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
if(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim())throw Error('Candidate packaging requires a clean tracked source tree.');
const files=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
const forbidden=/(^|\/)(node_modules|data|database|backups|uploads|logs|tmp|dist)(\/|$)|(^|\/)\.env($|\.)|\.(pfx|pem|key|whb|private\.json|exe)$/i;
if(files.some(file=>forbidden.test(file)))throw Error('Candidate contains protected or generated file path.');
const directory=join(root,'dist');await mkdir(directory,{recursive:true});const target=join(directory,`warehouse-inventory-${version}-candidate.zip`),zip=new yazl.ZipFile(),manifest=[];
try{for(const file of files){const path=join(root,file),info=await lstat(path);if(!info.isFile())throw Error('Only regular source files may be packaged.');const bytes=await readFile(path);manifest.push({path:file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});zip.addBuffer(bytes,'warehouse-inventory/'+file);}
 zip.addBuffer(Buffer.from(JSON.stringify({version,revision,candidate:true,requires:'Node.js, PostgreSQL, npm production dependency install, protected config, trusted HTTPS and real-device acceptance',files:manifest},null,2)),'warehouse-inventory/CANDIDATE-MANIFEST.json');const stream=pipeline(zip.outputStream,createWriteStream(target,{flags:'w'}));zip.end();await stream;const handle=await open(target,'r');const sum=createHash('sha256');try{for await(const chunk of handle.createReadStream({autoClose:false}))sum.update(chunk);}finally{await handle.close();}console.log(JSON.stringify({file:target,revision,sourceFiles:files.length,sha256:sum.digest('hex'),candidate:true}));
}catch(error){zip.end();await rm(target,{force:true});throw error;}

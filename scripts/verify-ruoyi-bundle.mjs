import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,writeFile} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const manifestName='bundle-manifest.json';
const permitted=/^(?:index\.html|(?:RuoYi|jsQR)-LICENSE\.txt|static\/(?:js\/[\w-]+\.js|css\/[\w-]+\.css)(?:\.gz)?)$/;
async function inspect(directory){
 if(!isAbsolute(directory))throw Error('MANAGEMENT_DIRECTORY_MUST_BE_ABSOLUTE');
 if(!(await lstat(directory)).isDirectory()||(await lstat(directory)).isSymbolicLink())throw Error('INVALID_MANAGEMENT_DIRECTORY');
 const files=[];
 async function walk(relative=''){
  for(const name of (await readdir(join(directory,relative))).sort()){
   const path=relative?relative+'/'+name:name,info=await lstat(join(directory,path));
   if(info.isSymbolicLink())throw Error('MANAGEMENT_SYMLINK');
   if(info.isDirectory()){
    if(!['static','static/js','static/css'].includes(path))throw Error('UNEXPECTED_MANAGEMENT_DIRECTORY');
    await walk(path);continue;
   }
   if(path===manifestName)continue;
   if(!info.isFile()||!permitted.test(path)||info.size>32*1024*1024||files.length>=256)throw Error('UNEXPECTED_MANAGEMENT_FILE');
   const bytes=await readFile(join(directory,path));
   files.push({path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
 }
 await walk();files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
 for(const name of ['index.html','RuoYi-LICENSE.txt','jsQR-LICENSE.txt'])if(!files.some(file=>file.path===name&&file.bytes>0))throw Error('INCOMPLETE_MANAGEMENT_BUNDLE');
 const html=await readFile(join(directory,'index.html'),'utf8');
 const refs=[...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map(match=>match[1]);
 if(!refs.length||refs.some(path=>!/^\/admin\/static\/(?:js\/[\w-]+\.js|css\/[\w-]+\.css)$/.test(path)||!files.some(file=>file.path===path.slice(7)&&file.bytes>0))||!refs.some(path=>path.endsWith('.js'))||!refs.some(path=>path.endsWith('.css'))||!/<title>LEE T Administration<\/title>/.test(html))throw Error('INVALID_MANAGEMENT_ENTRY');
 return {schema:1,product:'lee-t-management',files};
}
export async function sealRuoyiBundle(directory){
 const manifest=await inspect(directory);
 await writeFile(join(directory,manifestName),JSON.stringify(manifest)+'\n',{flag:'wx'});return manifest;
}
export async function verifyRuoyiBundle(directory){
 const info=await lstat(join(directory,manifestName));if(!info.isFile()||info.isSymbolicLink()||info.size>262144)throw Error('INVALID_MANAGEMENT_MANIFEST');
 const saved=JSON.parse(await readFile(join(directory,manifestName),'utf8')),actual=await inspect(directory);
 if(JSON.stringify(saved)!==JSON.stringify(actual))throw Error('MANAGEMENT_BUNDLE_CHANGED');return actual;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
 try{
  const [action,directory,...extra]=process.argv.slice(2);if(extra.length||!['seal','verify'].includes(action)||!directory)throw Error('Use seal|verify ABSOLUTE_DIRECTORY');
  const result=await(action==='seal'?sealRuoyiBundle:verifyRuoyiBundle)(directory);
  console.log('LEE T management bundle '+action+' passed: '+result.files.length+' files.');
 }catch(error){console.error('LEE T management bundle rejected: '+error.message);process.exitCode=1;}
}

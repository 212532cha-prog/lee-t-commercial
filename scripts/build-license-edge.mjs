import {build,version as compilerVersion} from 'esbuild';
import {readFile,writeFile,mkdir,readdir,lstat,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function buildLicenseEdge(directory){
 if(!isAbsolute(directory))throw Error('Use an absolute new build directory.');
 await mkdir(directory);let success=false;
 try{
  const outfile=join(directory,'lee-t-activation.mjs');
  const result=await build({absWorkingDir:root,entryPoints:['integrations/license-center/serve.mjs'],outfile,bundle:true,platform:'node',format:'esm',target:'es2022',external:['pg-native'],
   inject:[join(root,'integrations/license-center/compat.mjs')],metafile:true,
   banner:{js:"import {createRequire as leeTEdgeCreateRequire} from 'node:module'; const require=leeTEdgeCreateRequire(import.meta.url);"},logLevel:'silent'});
  const packages=new Map();
  for(const input of Object.keys(result.metafile.inputs).filter(path=>path.startsWith('node_modules/'))){
   let current=dirname(resolve(root,input));
   while(current.startsWith(join(root,'node_modules')+'/')){
    try{
     const data=JSON.parse(await readFile(join(current,'package.json'),'utf8'));
     if(data.name&&data.version){
      const files=await readdir(current),name=files.find(name=>/^licen[cs]e(?:\.md|\.txt)?$/i.test(name));
      let text;
      if(name){if((await lstat(join(current,name))).isSymbolicLink())throw Error('Runtime dependency license link: '+data.name);text=await readFile(join(current,name),'utf8');}
      else{
       const readme=files.find(name=>/^readme\.md$/i.test(name));const content=readme?await readFile(join(current,readme),'utf8'):'';
       const heading=/^#{1,6}\s+licen[cs]e\s*$/im.exec(content);
       if(heading){const tail=content.slice(heading.index+heading[0].length);text=tail.split(/\n#{1,6}\s/)[0].trim();}
       if(!text||text.length<100||!/copyright/i.test(text)||!/permission|redistribution/i.test(text))throw Error('Runtime dependency license missing: '+data.name);
      }
      packages.set(data.name+'@'+data.version,{name:data.name,version:data.version,text});break;
     }
    }catch(error){if(error.code!=='ENOENT')throw error;}
    current=dirname(current);
   }
  }
  if(!packages.size)throw Error('Runtime dependency inventory is empty.');
  const licenses=[...packages.values()].sort((a,b)=>a.name.localeCompare(b.name));
  const notices=licenses.map(p=>p.name+'@'+p.version+'\n\n'+p.text).join('\n\n----------------\n\n');
  await writeFile(join(directory,'THIRD-PARTY-LICENSES.txt'),notices);
  const code=await readFile(outfile,'utf8');
  await writeFile(outfile,code+'\n// THIRD-PARTY LICENSE NOTICES\n'+notices.split('\n').map(line=>'// '+line).join('\n')+'\n');
  const sourcePaths=Object.keys(result.metafile.inputs).filter(path=>!path.startsWith('node_modules/')).sort();
  const sources=await Promise.all(sourcePaths.map(async path=>({path:relative(root,resolve(root,path)).replaceAll('\\','/'),sha256:sha(await readFile(resolve(root,path)))})));
  const content=await readFile(outfile),lock=await readFile(join(root,'package-lock.json'));
  const manifest={schema:1,product:'lee-t-activation-edge',node:process.versions.node,compiler:'esbuild@'+compilerVersion,npmLockSha256:sha(lock),bundle:{file:'lee-t-activation.mjs',bytes:content.length,sha256:sha(content)},sources,dependencies:licenses.map(({name,version})=>({name,version}))};
  await writeFile(join(directory,'bundle-manifest.json'),JSON.stringify(manifest,null,2)+'\n');success=true;return manifest;
 }finally{if(!success)await rm(directory,{recursive:true,force:true});}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
 try{if(process.argv.length!==3)throw Error('Usage: node scripts/build-license-edge.mjs NEW_ABSOLUTE_DIRECTORY');const result=await buildLicenseEdge(resolve(process.argv[2]));console.log('LEE T Edge bundle built: '+result.bundle.bytes+' bytes; '+result.dependencies.length+' runtime licenses.');}
 catch(error){console.error('LEE T Edge build failed: '+error.message);process.exitCode=1;}
}

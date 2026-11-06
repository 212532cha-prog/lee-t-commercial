import {mkdtemp,chmod,access,rm} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {createBrotliDecompress} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import chromium from '@sparticuz/chromium';
import {chromium as playwright} from 'playwright-core';
const execute=promisify(execFile);
export async function launchBrowser(){
 if(process.platform==='win32'||process.env.BROWSER_EXECUTABLE_PATH){const candidates=[process.env.BROWSER_EXECUTABLE_PATH,...[process.env.PROGRAMFILES,process.env['PROGRAMFILES(X86)'],process.env.LOCALAPPDATA].filter(Boolean).flatMap(root=>[join(root,'Microsoft','Edge','Application','msedge.exe'),join(root,'Google','Chrome','Application','chrome.exe')])].filter(Boolean);let executablePath;for(const candidate of candidates){try{await access(candidate);executablePath=candidate;break;}catch{}}if(!executablePath)throw Error('Set BROWSER_EXECUTABLE_PATH to a local Chrome or Edge executable. Browser tests are mandatory.');return {browser:await playwright.launch({executablePath,headless:true}),async cleanup(){}};}
 const directory=await mkdtemp(join(tmpdir(),'warehouse-chromium-')),bin=fileURLToPath(new URL('../../node_modules/@sparticuz/chromium/bin/',import.meta.url));
 try{
  for(const name of ['chromium','fonts.tar','swiftshader.tar','al2023.tar']){const target=join(directory,name);await pipeline(createReadStream(join(bin,name+'.br')),createBrotliDecompress(),createWriteStream(target,{flags:'wx',mode:0o600}));if(name.endsWith('.tar')){await execute('tar',['--extract','--no-same-owner','--no-same-permissions','--file',target,'--directory',directory]);await rm(target);}else await chmod(target,0o700);}
  // Keep normal certificate and web security enforcement. No ignoreHTTPSErrors or cert bypass flags.
  const args=chromium.args.filter(arg=>!/(ignore.*cert|insecure|disable-web-security|single-process)/i.test(arg));
  const browser=await playwright.launch({executablePath:join(directory,'chromium'),args,headless:true,env:{...process.env,LD_LIBRARY_PATH:[join(directory,'lib'),process.env.LD_LIBRARY_PATH||''].join(delimiter)}});
  return {browser,async cleanup(){await rm(directory,{recursive:true,force:true});}};
 }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}

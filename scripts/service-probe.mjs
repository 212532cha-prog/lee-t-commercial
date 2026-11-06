// Used only by the Windows service integration test; never selected by the installer.
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const directory=process.env.DATA_DIR;if(!directory)throw Error('DATA_DIR required');await mkdir(directory,{recursive:true});await writeFile(join(directory,'probe-ready.txt'),'ready');
process.stdin.setEncoding('utf8');process.stdin.on('data',async value=>{if(value.trim()==='shutdown'){await writeFile(join(directory,'probe-stopped.txt'),'clean');process.stdin.destroy();}});

import fs from 'node:fs';
import {inspectGates} from '../src/preflight/gates.mjs';
const args=process.argv.slice(2),deployment=args.includes('--require-devices');
const path=args.find(arg=>!arg.startsWith('--'))||'docs/deployment/stage0-gates.json';
try {
 if(args.some(arg=>arg.startsWith('--')&&arg!=='--require-devices'))throw Error('Unknown option');
 const result=inspectGates(JSON.parse(fs.readFileSync(path,'utf8')),{scope:deployment?'deployment':'development'});
 console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
} catch(error){console.error(`Stage 0 gate invalid: ${error.message}`);process.exitCode=1;}

import fs from 'node:fs';
import {inspectSpecification} from '../src/preflight/specification.mjs';
const required=['PRD.md','开发计划.md','验收清单.md','.gitignore','package.json','docs/decisions/OPEN-DECISIONS.md'];
for(const path of required)if(!fs.existsSync(path))throw new Error(`Missing: ${path}`);
const ignore=fs.readFileSync('.gitignore','utf8');
for(const item of ['.env','*.key','backups/','data/'])if(!ignore.split('\n').includes(item))throw new Error(`Unsafe ignore: ${item}`);
const report=inspectSpecification({prd:fs.readFileSync('PRD.md','utf8'),plan:fs.readFileSync('开发计划.md','utf8'),acceptance:fs.readFileSync('验收清单.md','utf8')});
if(report.errors.length)throw new Error(report.errors.join('\n'));
console.log(`Stage 0 local repository checks passed: ${report.requirements} requirements, ${report.cases} acceptance cases. This is not the real-device gate.`);

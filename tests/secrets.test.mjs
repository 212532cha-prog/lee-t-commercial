import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectContent} from '../src/preflight/secrets.mjs';
test('synthetic keys and tokens are blocked without logging matching bytes',()=>{for(const secret of [['-----BEGIN',' PRIVATE KEY-----'].join(''),'ghp_'+'x'.repeat(36),'AKIA'+'A'.repeat(16)]){const findings=inspectContent('src/leak.txt',secret);assert.ok(findings.length);assert.ok(!JSON.stringify(findings).includes(secret))}});
test('tracked secret files, credential URLs, and production data are rejected',()=>{for(const path of ['.env','.env.production','cert.key','archive.dump','backups/old.zip','apps/api/data/prod.db','C:\\data\\current.json'])assert.ok(inspectContent(path,'').length,path);assert.ok(inspectContent('config.txt',['postgresql','://','user',':','secret','@','host/db'].join('')).length)});
test('examples and normal code are not treated as secrets',()=>{for(const path of ['.env.example','src/index.mjs','README.md'])assert.deepEqual(inspectContent(path,'PROBE_TLS_KEY=<path>\nno actual credentials'),[])});
test('literal password values are blocked, placeholders allowed',()=>{assert.ok(inspectContent('example.txt',['pass','word = '].join('')+'"'+'real-secret'+'"').length);assert.deepEqual(inspectContent('example.txt',['pass','word = '].join('')+'"'+'<provide securely>'+'"'),[])});

test('real scanner CLI blocks staged synthetic leaks and redacts output',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {execFileSync,spawnSync}=await import('node:child_process');
 const {fileURLToPath}=await import('node:url');
 const dir=mkdtempSync(join(tmpdir(),'warehouse-scan-test-'));
 try {
   execFileSync('git',['init','-q'],{cwd:dir});
   const value='ghp_'+'z'.repeat(36);
   writeFileSync(join(dir,'.env'),value);
   execFileSync('git',['add','.env'],{cwd:dir});
   const result=spawnSync(process.execPath,[fileURLToPath(new URL('../src/preflight/secrets.mjs',import.meta.url))],{cwd:dir,encoding:'utf8'});
   assert.equal(result.status,1);assert.match(result.stderr,/prohibited-file/);assert.match(result.stderr,/github-token/);
   assert.ok(!(result.stdout+result.stderr).includes(value));
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('reviewable schema migrations are allowed but SQL data dumps remain blocked',()=>{
 assert.deepEqual(inspectContent('migrations/001-identity.sql','CREATE TABLE users (id uuid PRIMARY KEY);'),[]);
 assert.ok(inspectContent('migrations/999-leak.sql','COPY users FROM stdin;').length);
 assert.ok(inspectContent('migrations/999-leak.sql',"INSERT INTO users VALUES ('data');").length);
 assert.ok(inspectContent('archive.sql','CREATE TABLE anything (id int);').length);
});

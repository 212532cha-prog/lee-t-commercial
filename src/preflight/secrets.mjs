import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const rules = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['credential-url', /(?:postgres(?:ql)?|mysql):\/\/[^\s/:]+:[^\s@]+@/],
];
export function inspectContent(path, content) {
  const normalized = path.replaceAll('\\', '/');
  const findings = [];
  const base = normalized.split('/').at(-1);
  if ((/^\.env(?:\..+)?$/.test(base) && base !== '.env.example') ||
      (/\.(?:key|pem|pfx|p12|dump|sql|sqlite3?|db|enc)$/i.test(base) && !/^migrations\/\d{3}-[a-z0-9-]+\.sql$/.test(normalized)) ||
      /(?:^|\/)(?:backups|data|database|uploads|logs)\//.test(normalized)) {
    findings.push({path, kind: 'prohibited-file'});
  }
  if (/\.sql$/i.test(base) && /\bCOPY\b|\\connect|pg_dump|INSERT\s+INTO\s+(?:public\.)?(?:users|sessions|products|inventory_transactions)\b/i.test(content)) findings.push({path, kind:'production-sql-data'});
  for (const [kind, pattern] of rules) {
    if (pattern.test(content)) findings.push({path, kind});
  }
  // Detect nonempty password assignments while permitting env names and placeholders.
  for (const match of content.matchAll(/(?:password|initial_password|admin_password)\s*[:=]\s*["']([^"'\r\n]+)["']/gi)) {
    const value = match[1];
    if (!/^(?:<[^>]+>|\$\{[^}]+\}|\*+|redacted|example|test-only)$/i.test(value)) {
      findings.push({path, kind: 'literal-password'});
    }
  }
  return findings;
}
export async function scanTrackedFiles(cwd = process.cwd()) {
  const names = execFileSync('git', ['ls-files', '-z'], {cwd, encoding: 'utf8'}).split('\0').filter(Boolean);
  const findings = [];
  for (const path of names) {
    const content = await readFile(`${cwd}/${path}`);
    findings.push(...inspectContent(path, content.toString('utf8')));
  }
  return {files: names.length, findings};
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await scanTrackedFiles();
  // Never print matching bytes: a failed scan must not leak credentials to CI logs.
  for (const finding of result.findings) console.error(`${finding.path}: ${finding.kind}`);
  console.log(`Secret scan: ${result.files} tracked files, ${result.findings.length} findings`);
  if (result.findings.length) process.exitCode = 1;
}

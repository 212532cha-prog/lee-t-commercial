export const developmentGates = Object.freeze([
  'repository-private', 'specification-consistent', 'local-tests', 'secret-scan', 'github-ci',
]);
export const deviceGates = Object.freeze([
  'windows-preflight', 'trusted-https-iphone', 'trusted-https-android', 'lan-without-internet',
  'physical-hid-and-labels', 'lan-loss-and-reconnect', 'windows-unattended-restart',
  'warehouse-network-exposure', 'physical-backup-volumes', 'physical-machine-restore',
  'upgrade-and-rollback', 'warehouse-user-acceptance',
]);
export const requiredGates = Object.freeze([...developmentGates, ...deviceGates]);
export function inspectGates(report, {scope = 'development'} = {}) {
  const blocked = [];
  if (!['development', 'deployment'].includes(scope)) return {passed:false,scope,blocked:[{id:'scope',reason:'unknown gate scope'}]};
  if (report?.revision !== 'REQ-20261101') blocked.push({id: 'revision', reason: 'wrong or missing revision'});
  if (report?.stage !== 0 || !Array.isArray(report?.gates)) return {passed:false,scope,blocked:[...blocked,{id:'schema',reason:'stage-0 gates array required'}]};
  const ids = report.gates.map(g => g.id);
  if (ids.length !== new Set(ids).size) blocked.push({id:'schema',reason:'duplicate gate IDs'});
  for (const id of scope === 'development' ? developmentGates : requiredGates) {
    const gate = report.gates.find(g => g.id === id);
    if (gate?.status !== 'passed') {blocked.push({id,reason:gate?.reason||'not verified'});continue;}
    if (typeof gate.evidence !== 'string' || !gate.evidence.trim() || typeof gate.verifiedAt !== 'string' || Number.isNaN(Date.parse(gate.verifiedAt))) blocked.push({id,reason:'passed gate needs evidence and verification time'});
  }
  return {passed:blocked.length===0,scope,blocked};
}

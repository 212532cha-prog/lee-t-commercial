export function inspectSpecification({prd, plan, acceptance}) {
  const errors = [];
  for (const [name, content] of Object.entries({prd, plan, acceptance})) {
    if (!content.includes('REQ-20261101')) errors.push(`${name}: missing revision baseline`);
  }
  const requirements = [...prd.matchAll(/^### ([A-Z]+-\d+) /gm)].map(m => m[1]);
  if (requirements.length !== new Set(requirements).size) errors.push('duplicate requirement ID');
  const cases = acceptance.split('\n').filter(line => /^\| [A-Z]+-T\d+ \|/.test(line)).map(line => {
    const cells = line.split('|').slice(1, -1).map(s => s.trim());
    return {id: cells[0], requirements: cells[1]?.split(',').map(s => s.trim()), action: cells[2], expected: cells[3], method: cells[4], status: cells[5]};
  });
  if (!requirements.length || !cases.length) errors.push('empty requirement or acceptance set');
  if (cases.length !== new Set(cases.map(c => c.id)).size) errors.push('duplicate acceptance ID');
  for (const requirement of requirements) {
    if (!cases.some(c => c.requirements?.includes(requirement))) errors.push(`uncovered requirement: ${requirement}`);
  }
  for (const c of cases) {
    for (const req of c.requirements ?? []) if (!requirements.includes(req)) errors.push(`${c.id}: unknown ${req}`);
    if (![c.action, c.expected, c.method].every(Boolean)) errors.push(`${c.id}: incomplete acceptance`);
    if (!['未执行', '通过', '失败', '阻塞'].includes(c.status)) errors.push(`${c.id}: invalid status`);
  }
  const countSection = prd.match(/### COUNT-08[^]*?(?=\n### |$)/)?.[0] ?? '';
  if (!countSection.includes('不改余额') || !countSection.includes('不增加库存版本')) errors.push('count must never mutate inventory');
  if (!prd.includes('不提供产品回收站') || !prd.includes('不提供计量单位字段')) errors.push('removed capabilities must stay removed');
  if (!prd.includes('清理不撤销交易，也不改变当前库存')) errors.push('cleanup must preserve current balance');
  return {requirements: requirements.length, cases: cases.length, errors};
}

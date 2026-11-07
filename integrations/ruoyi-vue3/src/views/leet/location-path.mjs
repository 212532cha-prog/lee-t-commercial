export function locationPath(id, locations) {
  const byId = new Map(locations.map(row => [row.id, row]));
  const visited = new Set();
  const names = [];
  let current = byId.get(id);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    names.unshift(current.builtin ? 'Unassigned' : current.name);
    current = byId.get(current.parentId);
  }
  return names.join(' / ');
}

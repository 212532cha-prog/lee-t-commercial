export class InventoryInputError extends Error {
  constructor(message) { super(message); this.name = 'InventoryInputError'; }
}
export function parseStockQuantity(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new InventoryInputError('库存必须是整数');
  const text = String(value).trim();
  if (!/^(0|[1-9]\d*)$/.test(text)) throw new InventoryInputError('库存必须是非负整数');
  const quantity = Number(text);
  if (!Number.isSafeInteger(quantity)) throw new InventoryInputError('库存超过安全整数范围');
  return quantity;
}
/**
 * Admin-only direct stock overwrite. The store adapter MUST persist only the
 * current quantity and revision; it MUST NOT append inventory, activity or audit
 * records. Transactional compare-and-set prevents lost updates.
 */
export async function setStockQuantity({ actor, productId, quantity, expectedRevision, store }) {
  if (actor?.role !== 'admin' || actor?.disabled === true) throw new Error('FORBIDDEN');
  if (typeof productId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(productId)) throw new InventoryInputError('无效产品编号');
  const nextQuantity = parseStockQuantity(quantity);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new InventoryInputError('无效库存版本');
  if (typeof store?.compareAndSetQuantity !== 'function') throw new TypeError('缺少库存持久化接口');
  const updated = await store.compareAndSetQuantity({ productId, quantity: nextQuantity, expectedRevision });
  if (!updated) throw new Error('STOCK_CONFLICT_OR_NOT_FOUND');
  return { productId, quantity: nextQuantity, revision: expectedRevision + 1 };
}

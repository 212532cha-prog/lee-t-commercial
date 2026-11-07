<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import InventoryHistory from './InventoryHistory.vue'
import ProductAssets from './ProductAssets.vue'
import ProductImport from './ProductImport.vue'
import { ElMessageBox } from 'element-plus'
import { locationPath } from './location-path.mjs'
import { createProductClient } from './product-api.mjs'

const api = createProductClient()
const products = ref([])
const masters = ref({ categories: [], locations: [], suppliers: [] })
const categoryId = ref('')
const locationId = ref('')
const cursor = ref(null)
const busy = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const detail = ref(null)
const draft = ref(null)
const historyProduct = ref(null)
const importing = ref(false)
const selectedLabels = ref([])
const batchUrl = computed(() => '/api/products/qr/print-batch?' + new URLSearchParams(selectedLabels.value.map(id => ['id',id])))
let activeRequest
let disposed = false
const errors = {
  LOGIN_REQUIRED: 'Please sign in to LEE T again.',
  ADMIN_REQUIRED: 'An Administrator account is required.',
  METADATA_VERSION_CONFLICT: 'Another device changed this product. Close the editor and reopen the product before saving.',
  HISTORY_PROTECTED: 'Recent stock history protects this product from deletion.',
  ADMIN_BACKUP_REQUIRED: 'Backup storage needs attention. Open Backups in the warehouse workspace.',
  MAINTENANCE: 'The warehouse is under maintenance. Try again after maintenance completes.',
  PRODUCT_IN_ACTIVE_TASK: 'An unfinished stocktake protects this product from deletion.',
}

function report(failure) {
  error.value = errors[failure.message] || 'The operation could not be confirmed. Refresh products and check the saved record before submitting again.'
}

async function load(append = false) {
  activeRequest?.abort()
  const controller = new AbortController()
  activeRequest = controller
  busy.value = true
  error.value = ''
  if (!append) { products.value = []; cursor.value = null; selectedLabels.value = [] }
  try {
    const result = await api.list({ categoryId: categoryId.value, locationId: locationId.value, cursor: append ? cursor.value : null, signal: controller.signal })
    if (controller.signal.aborted) return
    products.value = append ? [...products.value, ...result.products] : result.products
    cursor.value = result.nextCursor
  } catch (failure) {
    if (!controller.signal.aborted) report(failure)
  } finally {
    if (activeRequest === controller) busy.value = false
  }
}

async function open(id) {
  if (busy.value || saving.value) return
  activeRequest?.abort()
  const controller = new AbortController()
  activeRequest = controller
  busy.value = true
  error.value = ''
  try {
    const result = await api.detail(id, controller.signal)
    if (!controller.signal.aborted) detail.value = result
  } catch (failure) {
    if (!controller.signal.aborted) report(failure)
  } finally {
    if (activeRequest === controller) busy.value = false
  }
}

function edit(product) {
  error.value = ''
  notice.value = ''
  draft.value = product ? {
    id: product.id, detailsVersion: product.detailsVersion, name: product.name, productCode: product.productCode,
    categoryId: product.categoryId, locationId: product.locationId, individualCost: product.individualCost,
    minimumStock: product.minimumStock, supplierIds: product.suppliers.filter(row => !row.deleted).map(row => row.id),
    defaultSupplierId: product.suppliers.find(row => row.isDefault && !row.deleted)?.id || null,
  } : {
    name: '', productCode: '', categoryId: null, locationId: '00000000-0000-4000-8000-000000000001',
    individualCost: '0.00', minimumStock: 0, supplierIds: [], defaultSupplierId: null,
  }
}

async function save() {
  if (saving.value) return
  saving.value = true
  error.value = ''
  const { id, ...data } = draft.value
  try {
    const result = await api.save(id, data)
    if (disposed) return
    draft.value = null
    detail.value = await api.detail(id || result.id)
    notice.value = result.duplicateName ? 'Saved. Another product has the same name. Check its product code.' : 'Product saved.'
    await load()
  } catch (failure) {
    if (!disposed) report(failure)
  } finally {
    saving.value = false
  }
}

async function refreshAfterStock() {
  const id = detail.value?.id
  if (id) {
    try {
      const current = await api.detail(id)
      if (!disposed && detail.value?.id === id) detail.value = current
    } catch (failure) {
      if (!disposed) report(failure)
    }
  }
  if (!disposed) await load()
}

function closeHistory() {
  historyProduct.value = null
  refreshAfterStock()
}

function selectLabel(id,checked) {
  if (checked && selectedLabels.value.length < 50 && !selectedLabels.value.includes(id)) selectedLabels.value.push(id)
  if (!checked) selectedLabels.value = selectedLabels.value.filter(value => value !== id)
}
async function imported(count) {
  importing.value = false
  notice.value = count + ' products imported with stock 0.'
  await load()
}

async function remove() {
  if (saving.value) return
  const id = detail.value.id
  try {
    await ElMessageBox.confirm('Permanently delete this product and its related data? Recovery requires a valid full backup.', 'Delete product', { type: 'warning' })
    await ElMessageBox.confirm('Confirm permanent deletion again.', 'Final confirmation', { type: 'warning' })
  } catch { return }
  if (disposed) return
  saving.value = true
  error.value = ''
  try {
    const result = await api.remove(id)
    if (disposed) return
    detail.value = null
    notice.value = result.cleanupPending ? 'Deleted. File cleanup will be retried.' : 'Product deleted.'
    await load()
  } catch (failure) {
    if (!disposed) report(failure)
  } finally {
    saving.value = false
  }
}

async function initialize() {
  const controller = new AbortController()
  activeRequest = controller
  busy.value = true
  try {
    const result = await api.masters(controller.signal)
    if (disposed) return
    masters.value = result
    await load()
  } catch (failure) {
    if (!disposed) { busy.value = false; report(failure) }
  }
}
onMounted(initialize)
onUnmounted(() => { disposed = true; activeRequest?.abort() })
</script>

<template>
  <section v-loading="busy">
    <h1>Products</h1>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-alert v-if="notice" :title="notice" type="success" :closable="false" />
    <div class="catalog-toolbar">
      <el-select v-model="categoryId" aria-label="Category filter" placeholder="All categories" clearable :disabled="busy || saving" @change="load(false)">
        <el-option v-for="row in masters.categories" :key="row.id" :label="row.name" :value="row.id" />
      </el-select>
      <el-select v-model="locationId" aria-label="Location filter" placeholder="All locations" clearable :disabled="busy || saving" @change="load(false)">
        <el-option v-for="row in masters.locations" :key="row.id" :label="locationPath(row.id, masters.locations)" :value="row.id" />
      </el-select>
      <el-button :disabled="busy || saving" @click="initialize">Refresh</el-button>
      <el-button type="primary" :disabled="busy || saving" @click="edit(null)">Add product</el-button>
      <el-button :disabled="busy || saving" @click="importing = true">Import products</el-button>
      <a :href="batchUrl" target="_blank" rel="noopener" class="batch-print" :aria-disabled="!selectedLabels.length || busy || saving" @click="(!selectedLabels.length || busy || saving) && $event.preventDefault()">Print selected QR ({{ selectedLabels.length }}/50)</a>
    </div>
    <el-table :data="products" empty-text="No products">
      <el-table-column label="Labels" width="80"><template #default="{row}"><input type="checkbox" :aria-label="'Select QR label for '+row.productCode" :checked="selectedLabels.includes(row.id)" :disabled="busy || saving || !selectedLabels.includes(row.id) && selectedLabels.length >= 50" @change="selectLabel(row.id,$event.target.checked)"></template></el-table-column>
      <el-table-column prop="productCode" label="Product code" min-width="140" />
      <el-table-column prop="name" label="Product" min-width="200" />
      <el-table-column label="Category" min-width="140"><template #default="{ row }">{{ row.categoryName }} <el-tag v-if="row.categoryDeleted" type="info">Deleted</el-tag></template></el-table-column>
      <el-table-column label="Location" min-width="140"><template #default="{ row }">{{ locationPath(row.locationId, masters.locations) || row.locationName }}</template></el-table-column>
      <el-table-column prop="quantity" label="Current stock" min-width="120" />
      <el-table-column label="Actions" width="110"><template #default="{ row }">
        <el-button :disabled="busy || saving" @click="open(row.id)">Details</el-button>
      </template></el-table-column>
    </el-table>
    <el-button v-if="cursor" :disabled="busy || saving" @click="load(true)">Load more</el-button>
    <el-dialog :model-value="!!detail" title="Product details" :close-on-click-modal="false" :before-close="done => { if (!saving) { detail = null; done() } }">
      <template v-if="detail">
        <h2>{{ detail.name }}</h2><p>{{ detail.productCode }}</p>
        <ProductAssets :key="detail.id" :product="detail" @busy="value => saving = value" @updated="refreshAfterStock" />
        <el-descriptions :column="1" border>
          <el-descriptions-item label="Current stock">{{ detail.quantity }}</el-descriptions-item>
          <el-descriptions-item label="Minimum stock">{{ detail.minimumStock }}</el-descriptions-item>
          <el-descriptions-item label="Category">{{ detail.categoryName }} <el-tag v-if="detail.categoryDeleted" type="info">Deleted</el-tag></el-descriptions-item>
          <el-descriptions-item label="Location">{{ locationPath(detail.locationId, masters.locations) || detail.locationName }}</el-descriptions-item>
          <el-descriptions-item label="Individual cost (RM)">{{ detail.individualCost }}</el-descriptions-item>
          <el-descriptions-item label="Suppliers"><div v-for="(row, index) in detail.suppliers" :key="row.id || 'deleted-' + index">{{ row.name }}<span v-if="row.deleted"> (deleted)</span><span v-if="row.isDefault"> · Default</span></div></el-descriptions-item>
        </el-descriptions>
        <p><el-button :disabled="saving" @click="historyProduct = detail.id">Stock history</el-button>
        <el-button :disabled="saving" @click="edit(detail)">Edit product</el-button>
        <el-button type="danger" :disabled="saving" @click="remove">Delete permanently</el-button></p>
      </template>
    </el-dialog>
    <InventoryHistory v-if="historyProduct" :key="historyProduct" :product-id="historyProduct" @close="closeHistory" @updated="refreshAfterStock" />
    <ProductImport v-if="importing" :categories="masters.categories" :initial-category="categoryId" @close="importing = false" @imported="imported" />
    <el-dialog :model-value="!!draft" :title="draft?.id ? 'Edit product' : 'Add product'" :close-on-click-modal="false" :before-close="done => { if (!saving) { draft = null; done() } }">
      <el-form v-if="draft" label-position="top" @submit.prevent="save">
        <el-form-item label="Name"><el-input v-model="draft.name" maxlength="128" :disabled="saving" /></el-form-item>
        <el-form-item label="Product code (generated when empty)"><el-input v-model="draft.productCode" :disabled="saving" /></el-form-item>
        <el-form-item label="Category"><el-select v-model="draft.categoryId" :disabled="saving">
          <el-option v-for="row in masters.categories.filter(row => !row.deleted)" :key="row.id" :value="row.id" :label="row.name" />
        </el-select></el-form-item>
        <p v-if="draft.id && !draft.categoryId && detail?.categoryDeleted">Previous category {{ detail.categoryName }} (deleted) will be retained.</p>
        <el-form-item label="Location"><el-select v-model="draft.locationId" :disabled="saving">
          <el-option v-for="row in masters.locations.filter(row => !row.deleted)" :key="row.id" :value="row.id" :label="locationPath(row.id, masters.locations)" />
        </el-select></el-form-item>
        <el-form-item label="Individual cost (RM)"><el-input v-model="draft.individualCost" :disabled="saving" /></el-form-item>
        <el-form-item label="Minimum stock"><el-input-number v-model="draft.minimumStock" :min="0" :precision="0" :disabled="saving" /></el-form-item>
        <el-form-item label="Suppliers"><el-select v-model="draft.supplierIds" multiple :disabled="saving" @change="() => { if (!draft.supplierIds.includes(draft.defaultSupplierId)) draft.defaultSupplierId = null }">
          <el-option v-for="row in masters.suppliers.filter(row => !row.deleted)" :key="row.id" :value="row.id" :label="row.name" />
        </el-select></el-form-item>
        <el-form-item label="Default supplier"><el-select v-model="draft.defaultSupplierId" clearable :disabled="saving">
          <el-option v-for="row in masters.suppliers.filter(row => draft.supplierIds.includes(row.id))" :key="row.id" :value="row.id" :label="row.name" />
        </el-select></el-form-item>
        <el-button type="primary" native-type="submit" :loading="saving" :disabled="!draft.name.trim() || (!draft.categoryId && !(draft.id && detail?.categoryDeleted))">Save product</el-button>
        <el-button :disabled="saving" @click="draft = null">Cancel</el-button>
        <p v-if="!draft.id">New products start with stock 0.</p>
        <el-alert v-if="error" :title="error" type="error" :closable="false" />
      </el-form>
    </el-dialog>
  </section>
</template>

<style scoped>
.catalog-toolbar { display: flex; flex-wrap: wrap; gap: 12px; margin: 20px 0; }
.catalog-toolbar .el-select { width: 200px; }
.batch-print { display:inline-flex;align-items:center;padding:8px 14px;border:1px solid #dce2ec;border-radius:8px;color:#46546d;font-size:12px;text-decoration:none;background:white; }.batch-print[aria-disabled=true] { opacity:.5;pointer-events:none; }
</style>

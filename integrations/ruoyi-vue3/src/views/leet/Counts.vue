<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { createCountClient } from './count-api.mjs'
import { locationPath } from './location-path.mjs'

const api = createCountClient()
const mode = ref('tasks')
const tasks = ref([])
const reports = ref([])
const cursor = ref(null)
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const draft = ref(null)
const detail = ref(null)
const masters = ref({ categories: [], locations: [] })
const products = ref([])
const productCursor = ref(null)
const selectionLoading = ref(false)
let request
let disposed = false
let selectionEpoch = 0
const statuses = { pending: 'Pending', active: 'In progress', completed: 'Completed', cancelled: 'Cancelled' }
const validDraft = computed(() => draft.value?.title.trim() && (
  draft.value.scope === 'all' ||
  ['category', 'location'].includes(draft.value.scope) && draft.value.scopeId ||
  draft.value.scope === 'products' && draft.value.productIds.length > 0
))
const messages = {
  LOGIN_REQUIRED: 'Please sign in to LEE T again.',
  ADMIN_REQUIRED: 'An Administrator account is required.',
  EMPTY_SCOPE: 'The selected scope contains no products.',
  INVALID_SCOPE: 'Choose a valid stocktake scope.',
  INVALID_TITLE: 'Enter a title of up to 128 characters.',
  PRODUCT_NOT_FOUND_OR_DELETED: 'A selected product was deleted. Reopen the scope selector.',
  TASK_ALREADY_COMPLETED: 'This task is already completed. Refresh the list.',
  TASK_NOT_FOUND_OR_CANCELLED: 'This task is no longer available. Refresh the list.',
  REPORT_NOT_FOUND: 'This report is no longer available. Refresh the list.',
  REPORT_NOT_IN_TRASH: 'Move the report to trash before deleting it permanently.',
  ADMIN_BACKUP_REQUIRED: 'Backup storage needs attention. Open Backups in the warehouse workspace.',
  MAINTENANCE: 'The warehouse is under maintenance.',
}

function report(failure) {
  error.value = messages[failure.code] || messages[failure.message] || 'The result could not be confirmed. Refresh the list and check existing tasks or reports before trying again.'
}

async function load(append = false) {
  request?.abort()
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  const current = mode.value
  try {
    const result = current === 'tasks' ? await api.tasks(append ? cursor.value : null, controller.signal)
      : await api.reports(current === 'trash', append ? cursor.value : null, controller.signal)
    if (controller.signal.aborted || current !== mode.value) return
    if (current === 'tasks') tasks.value = append ? [...tasks.value, ...result.tasks] : result.tasks
    else reports.value = append ? [...reports.value, ...result.reports] : result.reports
    cursor.value = result.nextCursor
  } catch (failure) {
    if (!controller.signal.aborted) report(failure)
  } finally {
    if (request === controller) loading.value = false
  }
}

function changeMode(value) {
  mode.value = value
  tasks.value = []
  reports.value = []
  cursor.value = null
  notice.value = ''
  load()
}

async function moreProducts() {
  if (selectionLoading.value || disposed) return
  const epoch = selectionEpoch
  selectionLoading.value = true
  try {
    const result = await api.products(productCursor.value)
    if (disposed || !draft.value || epoch !== selectionEpoch) return
    const known = new Set(products.value.map(row => row.id))
    products.value.push(...result.products.filter(row => !known.has(row.id)))
    productCursor.value = result.nextCursor
  } catch (failure) { if (!disposed && epoch === selectionEpoch && draft.value) report(failure) }
  finally { if (epoch === selectionEpoch) selectionLoading.value = false }
}

async function publishForm(task) {
  if (loading.value || saving.value) return
  const epoch = ++selectionEpoch
  selectionLoading.value = false
  loading.value = true
  error.value = ''
  notice.value = ''
  try {
    const [refs, page, existing] = await Promise.all([api.masters(), api.products(), task ? api.task(task.id) : Promise.resolve(null)])
    if (disposed || epoch !== selectionEpoch) return
    masters.value = refs
    products.value = page.products
    productCursor.value = page.nextCursor
    draft.value = {
      title: task ? task.title : '', scope: task ? 'products' : 'all', scopeId: '',
      productIds: existing ? existing.items.map(row => row.productId) : [],
    }
    if (existing) {
      const known = new Set(products.value.map(row => row.id))
      products.value.push(...existing.items.filter(row => !known.has(row.productId)).map(row => ({ id: row.productId, name: row.name, productCode: row.productCode })))
    }
  } catch (failure) { if (!disposed) report(failure) }
  finally { loading.value = false }
}

async function publish() {
  if (saving.value || !validDraft.value) return
  saving.value = true
  error.value = ''
  const input = { title: draft.value.title, scope: draft.value.scope }
  if (input.scope === 'products') input.productIds = [...draft.value.productIds]
  if (['category', 'location'].includes(input.scope)) input.scopeId = draft.value.scopeId
  try {
    await api.publish(input)
    if (disposed) return
    draft.value = null
    notice.value = 'Stocktake published with a fixed product scope.'
    mode.value = 'tasks'
    await load()
  } catch (failure) { if (!disposed) report(failure) }
  finally { saving.value = false }
}

async function view(row) {
  if (loading.value || saving.value) return
  loading.value = true
  error.value = ''
  try {
    const result = mode.value === 'tasks' ? await api.task(row.id) : await api.report(row.id)
    if (!disposed) detail.value = result
  } catch (failure) { if (!disposed) report(failure) }
  finally { loading.value = false }
}

async function taskAction(row, remove) {
  if (loading.value || saving.value) return
  try { await ElMessageBox.confirm((remove ? 'Delete' : 'Cancel') + ' task "' + row.title + '"? Active employee counting will stop.', 'Confirm task action', { type: 'warning' }) }
  catch { return }
  if (disposed) return
  saving.value = true
  error.value = ''
  try {
    await api.cancel(row.id, remove)
    if (disposed) return
    notice.value = remove ? 'Task deleted.' : 'Task cancelled.'
    await load()
  } catch (failure) { if (!disposed) report(failure) }
  finally { saving.value = false }
}

async function reportAction(row, action) {
  if (loading.value || saving.value) return
  try {
    await ElMessageBox.confirm(action === 'delete' ? 'Permanently delete this report? Recovery requires a valid backup.' : action === 'trash' ? 'Move this report to trash?' : 'Restore this report?', 'Confirm report action', { type: 'warning' })
    if (action === 'delete') await ElMessageBox.confirm('Confirm permanent deletion again.', 'Final report confirmation', { type: 'warning' })
  } catch { return }
  if (disposed) return
  saving.value = true
  error.value = ''
  try {
    await api.reportAction(action, [row.id])
    if (disposed) return
    detail.value = null
    notice.value = action === 'delete' ? 'Report permanently deleted.' : action === 'trash' ? 'Report moved to trash.' : 'Report restored.'
    await load()
  } catch (failure) { if (!disposed) report(failure) }
  finally { saving.value = false }
}

onMounted(() => load())
onUnmounted(() => { disposed = true; selectionEpoch++; request?.abort() })
</script>

<template>
  <section v-loading="loading">
    <div class="count-heading"><div><h1>Stocktakes</h1><p class="count-hint">Publish fixed scopes and review completed counts.</p></div><el-button type="primary" :disabled="loading || saving" @click="publishForm(null)">Publish task</el-button></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-alert v-if="notice" :title="notice" type="success" :closable="false" />
    <div class="count-toolbar"><el-button v-for="(label, key) in {tasks:'Tasks',reports:'Reports',trash:'Report trash'}" :key="key" :type="mode === key ? 'primary' : 'default'" :disabled="loading || saving" @click="changeMode(key)">{{ label }}</el-button><el-button :disabled="loading || saving" @click="load(false)">Refresh stocktakes</el-button></div>
    <template v-if="mode === 'tasks'">
      <el-table :data="tasks" empty-text="No stocktake tasks">
        <el-table-column prop="taskCode" label="Task" min-width="130" /><el-table-column prop="title" label="Title" min-width="180" />
        <el-table-column label="Status" min-width="110"><template #default="{row}"><el-tag :type="row.status === 'completed' ? 'success' : row.status === 'cancelled' ? 'info' : 'primary'">{{ statuses[row.status] }}</el-tag></template></el-table-column>
        <el-table-column prop="productCount" label="Products" width="100" />
        <el-table-column label="Actions" min-width="360"><template #default="{row}"><div class="count-actions">
          <el-button :disabled="loading || saving" @click="view(row)">View scope</el-button>
          <el-button :disabled="loading || saving" @click="publishForm(row)">Republish</el-button>
          <el-button v-if="['pending','active'].includes(row.status)" :disabled="loading || saving" @click="taskAction(row, false)">Cancel task</el-button>
          <el-button v-if="row.status !== 'completed'" type="danger" :disabled="loading || saving" @click="taskAction(row, true)">Delete task</el-button>
        </div></template></el-table-column>
      </el-table>
    </template>
    <template v-else>
      <p class="count-hint">Reports preserve submitted quantities. Report actions leave inventory quantities unchanged.</p>
      <el-table :data="reports" empty-text="No count reports">
        <el-table-column prop="reportCode" label="Report" min-width="140" /><el-table-column prop="title" label="Title" min-width="170" />
        <el-table-column prop="employeeName" label="Employee" min-width="130" /><el-table-column prop="productCount" label="Products" width="90" /><el-table-column prop="differenceCount" label="Differences" width="110" />
        <el-table-column label="Actions" min-width="270"><template #default="{row}"><div class="count-actions">
          <el-button :disabled="loading || saving" @click="view(row)">View report</el-button>
          <el-button :disabled="loading || saving" @click="reportAction(row, mode === 'trash' ? 'restore' : 'trash')">{{ mode === 'trash' ? 'Restore report' : 'Move to trash' }}</el-button>
          <el-button v-if="mode === 'trash'" type="danger" :disabled="loading || saving" @click="reportAction(row, 'delete')">Delete permanently</el-button>
        </div></template></el-table-column>
      </el-table>
    </template>
    <el-button v-if="cursor" class="count-more" :disabled="loading || saving" @click="load(true)">Load more stocktakes</el-button>
    <el-dialog :model-value="!!draft" title="Publish stocktake" :close-on-click-modal="false" :before-close="done => { if (!saving) { draft = null; done() } }">
      <el-form v-if="draft" label-position="top" @submit.prevent="publish">
        <p>Publishing fixes the product scope. Republishing creates a separate task.</p>
        <el-form-item label="Task title"><el-input v-model="draft.title" maxlength="128" :disabled="saving" /></el-form-item>
        <el-form-item label="Product scope"><el-select v-model="draft.scope" :disabled="saving" @change="draft.scopeId = ''">
          <el-option value="all" label="All products" /><el-option value="category" label="Category" /><el-option value="location" label="Location" /><el-option value="products" label="Selected products" />
        </el-select></el-form-item>
        <el-form-item v-if="draft.scope === 'category'" label="Category"><el-select v-model="draft.scopeId" :disabled="saving"><el-option v-for="row in masters.categories" :key="row.id" :value="row.id" :label="row.name" /></el-select></el-form-item>
        <el-form-item v-if="draft.scope === 'location'" label="Location"><el-select v-model="draft.scopeId" :disabled="saving"><el-option v-for="row in masters.locations" :key="row.id" :value="row.id" :label="locationPath(row.id, masters.locations)" /></el-select></el-form-item>
        <template v-if="draft.scope === 'products'">
          <el-form-item label="Products"><el-select v-model="draft.productIds" multiple :multiple-limit="1000" filterable :disabled="saving"><el-option v-for="row in products" :key="row.id" :value="row.id" :label="row.productCode + ' · ' + row.name" /></el-select></el-form-item>
          <el-button v-if="productCursor" :loading="selectionLoading" :disabled="saving" @click="moreProducts">Load more products</el-button>
        </template>
        <el-alert v-if="error" :title="error" type="error" :closable="false" />
        <el-button type="primary" native-type="submit" :loading="saving" :disabled="!validDraft || selectionLoading">Publish stocktake</el-button>
        <el-button :disabled="saving" @click="draft = null">Cancel</el-button>
      </el-form>
    </el-dialog>
    <el-dialog :model-value="!!detail" :title="detail?.report ? 'Count report' : 'Stocktake scope'" width="85%" :before-close="done => { detail = null; done() }">
      <template v-if="detail">
        <h2>{{ (detail.report || detail.task).title }}</h2>
        <p v-if="detail.report">{{ detail.report.reportCode }} · {{ detail.report.employeeName }} · {{ new Date(detail.report.submittedAt).toLocaleString('en-GB', {timeZone:'Asia/Kuala_Lumpur'}) }}</p>
        <el-table :data="detail.items">
          <el-table-column prop="productCode" label="Product code" min-width="130" /><el-table-column prop="name" label="Product" min-width="180" />
          <template v-if="detail.report"><el-table-column prop="systemQuantity" label="System quantity" /><el-table-column prop="actualQuantity" label="Counted quantity" /><el-table-column prop="difference" label="Difference" /></template>
          <el-table-column v-else prop="quantity" label="Current quantity" />
        </el-table>
        <el-button @click="detail = null">Close stocktake details</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.count-heading { display:flex;justify-content:space-between;align-items:center;gap:20px; }
.count-hint { color:#66758a;line-height:1.7; }
.count-toolbar,.count-actions { display:flex;flex-wrap:wrap;gap:8px;margin:18px 0; }
.count-actions { margin:0; }.count-actions .el-button { margin-left:0; }.count-more { margin-top:16px; }
</style>

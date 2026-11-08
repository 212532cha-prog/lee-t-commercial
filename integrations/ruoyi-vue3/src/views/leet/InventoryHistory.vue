<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import HistoryCleanup from './HistoryCleanup.vue'
import { createInventoryClient } from './inventory-api.mjs'

const props = defineProps({ productId: { type: String, required: true } })
const emit = defineEmits(['close', 'updated'])
const api = createInventoryClient()
const product = ref(null)
const events = ref([])
const cursor = ref(null)
const selected = ref([])
const cleanupLocked = ref(false)
const cleanupBusy = ref(false)
const restoreMarker = ref(null)
const kind = ref('')
const from = ref('')
const to = ref('')
const order = ref('newest')
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const draft = ref(null)
const clock = ref(Date.now())
let offset = 0
let request
let disposed = false
const timer = setInterval(() => { clock.value = Date.now() }, 1000)
const labels = { inbound: 'Stock in', outbound: 'Stock out', adjustment: 'Adjustment' }
const validQuantity = computed(() => {
  if (!draft.value) return false
  const value = draft.value.quantity
  return /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) &&
    (draft.value.mode === 'overwrite' ? Number(value) >= 0 : draft.value.kind === 'adjustment' || Number(value) > 0)
})
const messages = {
  LOGIN_REQUIRED: 'Please sign in to LEE T again.',
  ADMIN_REQUIRED: 'An Administrator account is required.',
  STOCK_VERSION_CONFLICT: 'Stock quantity changed. Close the editor, refresh stock history, then check the latest quantity.',
  HISTORY_VERSION_CONFLICT: 'This record has changed. Close the editor, refresh stock history, then reopen the record.',
  HISTORY_IMMUTABLE: 'This record is outside the correction period.',
  CHECKPOINT_CONFLICT: 'A later quantity setting protects the current stock. Refresh stock history before continuing.',
  INVALID_QUANTITY: 'Enter a whole number within the supported range.',
  PRODUCT_NOT_FOUND: 'This product is no longer available.',
  PRODUCT_NOT_FOUND_OR_DELETED: 'This product is no longer available.',
  EVENT_NOT_FOUND: 'This record is no longer available. Refresh stock history.',
  ADMIN_BACKUP_REQUIRED: 'Backup storage needs attention. Open Backups in the warehouse workspace.',
  MAINTENANCE: 'The warehouse is under maintenance.',
}

function report(failure) {
  error.value = messages[failure.code] || messages[failure.message] || 'The result could not be confirmed. Refresh stock history and check the current quantity before submitting again.'
}

async function load(append = false) {
  request?.abort()
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  if (!append) { events.value = []; cursor.value = null; selected.value = [] }
  try {
    const [current, history] = await Promise.all([
      api.detail(props.productId, controller.signal),
      api.history(props.productId, {
        kind: kind.value, order: order.value, cursor: append ? cursor.value : null,
        from: from.value ? from.value + 'T00:00:00+08:00' : null,
        to: to.value ? to.value + 'T23:59:59.999+08:00' : null, signal: controller.signal,
      }),
    ])
    if (controller.signal.aborted) return
    product.value = current
    restoreMarker.value = history.restoreMarker
    offset = Date.parse(history.serverTime) - Date.now()
    clock.value = Date.now()
    events.value = append ? [...events.value, ...history.events] : history.events
    cursor.value = history.nextCursor
  } catch (failure) {
    if (!controller.signal.aborted) report(failure)
  } finally {
    if (request === controller) loading.value = false
  }
}

function begin(row) {
  if(cleanupLocked.value) return
  error.value = ''
  notice.value = ''
  draft.value = row ? {
    mode: 'correct', id: row.id, kind: row.kind, expectedRevision: row.revision,
    quantity: String(row.kind === 'adjustment' ? row.afterQuantity : Math.abs(row.quantityDelta)),
  } : {
    mode: 'overwrite', quantity: String(product.value.quantity), expectedVersion: product.value.inventoryVersion,
  }
}

async function cleanupUpdated() { selected.value=[];emit('updated');await load() }

async function save() {
  if (cleanupLocked.value || saving.value || !validQuantity.value) return
  const current = { ...draft.value }
  saving.value = true
  error.value = ''
  try {
    const text = current.mode === 'overwrite'
      ? 'Set current stock to ' + current.quantity + '? Existing history remains available.'
      : 'Correct the quantity in this record? The editable stock history and current balance will be recalculated.'
    await ElMessageBox.confirm(text, 'Confirm stock change', { type: 'warning' })
    if (current.mode === 'overwrite') await ElMessageBox.confirm('Confirm the new current quantity again.', 'Final stock confirmation', { type: 'warning' })
    if (disposed) return
    if (current.mode === 'overwrite') await api.overwrite(props.productId, { quantity: current.quantity, expectedVersion: current.expectedVersion })
    else await api.correct(props.productId, current.id, { quantity: current.quantity, expectedRevision: current.expectedRevision })
    if (disposed) return
    draft.value = null
    notice.value = 'Stock updated.'
    emit('updated')
    await load()
  } catch (failure) {
    if (!disposed && failure !== 'cancel' && failure !== 'close') report(failure)
  } finally {
    saving.value = false
  }
}

function canCorrect(row) {
  return Date.parse(row.protectedUntil) > clock.value + offset
}

function close() {
  if (!saving.value && !cleanupBusy.value) emit('close')
}

onMounted(() => load())
onUnmounted(() => { disposed = true; request?.abort(); clearInterval(timer) })
</script>

<template>
  <el-dialog :model-value="true" title="Stock history" width="90%" :close-on-click-modal="false" :before-close="done => { if (!saving && !cleanupBusy) { close(); done() } }">
    <section v-loading="loading">
      <template v-if="product"><h2>{{ product.name }}</h2><p>{{ product.productCode }} · Current stock {{ product.quantity }}</p></template>
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <el-alert v-if="notice" :title="notice" type="success" :closable="false" />
      <div class="history-toolbar">
        <el-select v-model="kind" aria-label="Stock event type" placeholder="All stock events" clearable :disabled="loading || saving || cleanupLocked">
          <el-option v-for="(label, value) in labels" :key="value" :value="value" :label="label" />
        </el-select>
        <el-date-picker v-model="from" type="date" value-format="YYYY-MM-DD" placeholder="From date" aria-label="From date" :disabled="loading || saving || cleanupLocked" />
        <el-date-picker v-model="to" type="date" value-format="YYYY-MM-DD" placeholder="To date" aria-label="To date" :disabled="loading || saving || cleanupLocked" />
        <el-select v-model="order" aria-label="History order" :disabled="loading || saving || cleanupLocked">
          <el-option value="newest" label="Newest first" /><el-option value="oldest" label="Oldest first" />
        </el-select>
        <el-button :disabled="loading || saving || cleanupLocked" @click="load(false)">Refresh stock history</el-button>
        <el-button type="primary" :disabled="!product || loading || saving || cleanupLocked" @click="begin(null)">Set current quantity</el-button>
      </div>
      <p>Stock history times use Malaysia time. Recent records are protected from deletion for 168 hours. Corrections use record versions and the warehouse server clock.</p>
      <HistoryCleanup v-if="product" :key="productId+String(restoreMarker)" :product-id="productId" :restore-marker="restoreMarker" :selected="selected" :disabled="loading || saving || !!draft" @locked="cleanupLocked=$event" @busy="cleanupBusy=$event" @updated="cleanupUpdated" />
      <el-table :data="events" empty-text="No stock history">
        <el-table-column label="Select" width="80"><template #default="{ row }"><input v-model="selected" type="checkbox" :value="row.id" :aria-label="'Select history record '+row.id" :disabled="loading || saving || cleanupLocked || canCorrect(row)" /></template></el-table-column>
        <el-table-column label="Time" min-width="180"><template #default="{ row }">{{ new Date(row.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur' }) }}</template></el-table-column>
        <el-table-column label="Type" min-width="100"><template #default="{ row }">{{ labels[row.kind] }}</template></el-table-column>
        <el-table-column prop="beforeQuantity" label="Before" width="90" />
        <el-table-column prop="quantityDelta" label="Change" width="90" />
        <el-table-column prop="afterQuantity" label="After" width="90" />
        <el-table-column label="Deletion protection" min-width="180"><template #default="{ row }">{{ canCorrect(row) ? new Date(row.protectedUntil).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur' }) : 'Protection period ended' }}</template></el-table-column>
        <el-table-column label="Action" width="150"><template #default="{ row }">
          <el-button :disabled="loading || saving || cleanupLocked || !canCorrect(row)" @click="begin(row)">Correct record</el-button>
        </template></el-table-column>
      </el-table>
      <el-button v-if="cursor" :disabled="loading || saving || cleanupLocked" @click="load(true)">Load more history</el-button>
      <p><el-button :disabled="saving || cleanupBusy" @click="close">Close stock history</el-button></p>
    </section>
    <el-dialog :model-value="!!draft" :title="draft?.mode === 'overwrite' ? 'Set current quantity' : 'Correct stock record'" append-to-body :close-on-click-modal="false" :before-close="done => { if (!saving) { draft = null; done() } }">
      <el-form v-if="draft" label-position="top" @submit.prevent="save">
        <el-form-item label="Quantity"><el-input v-model="draft.quantity" inputmode="numeric" :disabled="saving" /></el-form-item>
        <el-alert v-if="error" :title="error" type="error" :closable="false" />
        <el-button type="primary" native-type="submit" :disabled="!validQuantity" :loading="saving">Save stock quantity</el-button>
        <el-button :disabled="saving" @click="draft = null">Cancel</el-button>
      </el-form>
    </el-dialog>
  </el-dialog>
</template>

<style scoped>
.history-toolbar { display: flex; flex-wrap: wrap; gap: 10px; margin: 18px 0; }
.history-toolbar .el-select { width: 170px; }
</style>

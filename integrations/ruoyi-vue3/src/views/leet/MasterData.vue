<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { locationPath } from './location-path.mjs'
import { createProductClient } from './product-api.mjs'

const api = createProductClient()
const kinds = { categories: 'Categories', suppliers: 'Suppliers', locations: 'Locations' }
const kind = ref('categories')
const masters = ref({ categories: [], suppliers: [], locations: [] })
const rows = computed(() => masters.value[kind.value])
const busy = ref(false)
const error = ref('')
const notice = ref('')
const draft = ref(null)
let request
let disposed = false

function fail(failure) {
  const messages = {
    MASTER_VERSION_CONFLICT: 'Another device changed this record. Close the editor, refresh the list, then reopen the record.',
    LOCATION_CYCLE: 'A location cannot be placed inside itself or its descendants.',
    LOCATION_NOT_FOUND: 'The parent location changed. Refresh the location list.',
    BUILTIN_LOCATION: 'The built-in Unassigned location is protected.',
    ADMIN_REQUIRED: 'An Administrator account is required.',
    LOGIN_REQUIRED: 'Please sign in to LEE T again.',
    MASTER_NOT_FOUND: 'This record has been deleted. Refresh the list.',
    ADMIN_BACKUP_REQUIRED: 'Backup storage needs attention. Open Backups in the warehouse workspace.',
    MAINTENANCE: 'The warehouse is under maintenance.',
  }
  error.value = messages[failure.message] || 'The operation could not complete. Refresh the list and check the connection.'
}

async function refresh() {
  request?.abort()
  const controller = new AbortController()
  request = controller
  busy.value = true
  error.value = ''
  try {
    const result = await api.masters(controller.signal)
    if (!controller.signal.aborted) masters.value = result
  } catch (failure) {
    if (!controller.signal.aborted) fail(failure)
  } finally {
    if (request === controller) busy.value = false
  }
}

function edit(row) {
  notice.value = ''
  error.value = ''
  draft.value = { kind: kind.value, id: row?.id, name: row?.name || '', revision: row?.revision, parentId: row?.parentId || null }
}

async function save() {
  if (busy.value) return
  const { kind: target, id, ...data } = draft.value
  busy.value = true
  error.value = ''
  try {
    await api.saveMaster(target, id, data)
    if (disposed) return
    draft.value = null
    notice.value = 'Master data saved.'
    await refresh()
  } catch (failure) {
    if (!disposed) fail(failure)
  } finally {
    busy.value = false
  }
}

async function remove(row) {
  if (busy.value || row.builtin) return
  const target = kind.value
  const description = target === 'locations'
    ? 'Delete this location? Products in this location and its descendants move to Unassigned. Stock quantities stay unchanged.'
    : 'Delete this record? Existing products keep their stock quantities and retain the previous name as a deleted reference.'
  try {
    await ElMessageBox.confirm(description, 'Delete master data', { type: 'warning' })
    await ElMessageBox.confirm('Confirm deletion again.', 'Final confirmation', { type: 'warning' })
  } catch { return }
  if (disposed) return
  busy.value = true
  error.value = ''
  try {
    await api.removeMaster(target, row.id)
    if (disposed) return
    notice.value = 'Master data deleted.'
    await refresh()
  } catch (failure) {
    if (!disposed) fail(failure)
  } finally {
    busy.value = false
  }
}

function selectKind(value) {
  kind.value = value
  error.value = ''
  notice.value = ''
}

function parentName(id) {
  return locationPath(id, masters.value.locations) || 'Root'
}

onMounted(refresh)
onUnmounted(() => { disposed = true; request?.abort() })
</script>

<template>
  <section v-loading="busy">
    <h1>Master data</h1>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-alert v-if="notice" :title="notice" type="success" :closable="false" />
    <div role="tablist" aria-label="Master data types" class="master-toolbar">
      <el-button v-for="(label, value) in kinds" :key="value" role="tab" :aria-selected="kind === value" :type="kind === value ? 'primary' : 'default'" :disabled="busy" @click="selectKind(value)">{{ label }}</el-button>
    </div>
    <div class="master-toolbar">
      <el-button :disabled="busy" @click="refresh">Refresh master data</el-button>
      <el-button type="primary" :disabled="busy" @click="edit(null)">Add record</el-button>
    </div>
    <el-table :data="rows" empty-text="No master data">
      <el-table-column label="Name" min-width="220"><template #default="{ row }">{{ kind === 'locations' ? locationPath(row.id, masters.locations) : row.name }}</template></el-table-column>
      <el-table-column v-if="kind === 'locations'" label="Parent" min-width="180"><template #default="{ row }">{{ parentName(row.parentId) }}</template></el-table-column>
      <el-table-column label="Actions" width="240"><template #default="{ row }">
        <span v-if="row.builtin">Built-in location</span>
        <template v-else>
          <el-button :disabled="busy" @click="edit(row)">Edit record</el-button>
          <el-button type="danger" :disabled="busy" @click="remove(row)">Delete record</el-button>
        </template>
      </template></el-table-column>
    </el-table>
    <el-dialog :model-value="!!draft" :title="draft?.id ? 'Edit master data' : 'Add master data'" :close-on-click-modal="false" :before-close="done => { if (!busy) { draft = null; done() } }">
      <el-form v-if="draft" label-position="top" @submit.prevent="save">
        <el-form-item label="Name"><el-input v-model="draft.name" maxlength="128" :disabled="busy" /></el-form-item>
        <el-form-item v-if="draft.kind === 'locations'" label="Parent location">
          <el-select v-model="draft.parentId" clearable placeholder="Root" :disabled="busy">
            <el-option v-for="row in masters.locations.filter(row => row.id !== draft.id)" :key="row.id" :label="locationPath(row.id, masters.locations)" :value="row.id" />
          </el-select>
        </el-form-item>
        <el-alert v-if="error" :title="error" type="error" :closable="false" />
        <el-button native-type="submit" type="primary" :loading="busy" :disabled="!draft.name.trim()">Save record</el-button>
        <el-button :disabled="busy" @click="draft = null">Cancel</el-button>
      </el-form>
    </el-dialog>
  </section>
</template>

<style scoped>
.master-toolbar { margin: 16px 0; }
</style>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { createTeamClient } from './team-api.mjs'

const api = createTeamClient()
const employees = ref([])
const pairingEnabled = ref(false)
const administratorMobilePairing = ref(false)
const administratorQr = ref(false)
const administratorQrFailed = ref(false)
const administratorQrUrl = '/api/commercial/administrator-qr'
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const draft = ref(null)
const qr = ref(null)
let request
let expiryTimer
let disposed = false
const messages = {
  PAIRING_EXPIRED: 'The pairing code expired. Generate a new code.',
  LOGIN_REQUIRED: 'Please sign in to LEE T again.',
  ADMIN_REQUIRED: 'An Administrator account is required.',
  USERNAME_EXISTS: 'This username is already in use.',
  INVALID_USERNAME: 'Enter a valid username of up to 64 characters.',
  INVALID_NAME: 'Enter a full name of up to 128 characters.',
  'INVALID_PASSWORD': 'Use a password of 6 to 128 characters.',
  PROFILE_VERSION_CONFLICT: 'Another device changed this employee. Close the editor, refresh the list, then reopen the record.',
  EMPLOYEE_ALREADY_PAIRED: 'This employee already has a paired device. Unbind it before pairing a replacement.',
  EMPLOYEE_INACTIVE: 'This employee is inactive.',
  EMPLOYEE_NOT_FOUND: 'This employee is no longer available. Refresh the list.',
  ADMIN_BACKUP_REQUIRED: 'Backup storage needs attention. Open Backups in the warehouse workspace.',
  MAINTENANCE: 'The warehouse is under maintenance.',
}

const invalidDraft = computed(() => {
  const value = draft.value
  if (!value) return true
  if (value.mode !== 'password' && (!value.username.trim() || !value.realName.trim())) return true
  return value.mode !== 'edit' && (value.password.length < 6 || value.password.length > 128 || value.password !== value.confirmation)
})

function report(failure) {
  error.value = messages[failure.code] || messages[failure.message] || 'The operation could not be confirmed. Refresh the employee list before retrying.'
}

function clearDraft() {
  if (draft.value) { draft.value.password = ''; draft.value.confirmation = '' }
  draft.value = null
}

function closeQr() {
  clearTimeout(expiryTimer)
  if (qr.value) URL.revokeObjectURL(qr.value.url)
  qr.value = null
}

async function refresh() {
  request?.abort()
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  closeQr()
  try {
    const [session, rows] = await Promise.all([api.session(controller.signal), api.list(controller.signal)])
    if (controller.signal.aborted) return
    pairingEnabled.value = !!session.employeePairing
    administratorMobilePairing.value = !!session.administratorMobilePairing
    employees.value = rows
  } catch (failure) {
    if (!controller.signal.aborted) { employees.value = []; report(failure) }
  } finally {
    if (request === controller) loading.value = false
  }
}

function edit(row, mode = 'edit') {
  clearDraft()
  error.value = ''
  notice.value = ''
  draft.value = {
    mode: row ? mode : 'create', id: row?.id, username: row?.username || '', realName: row?.realName || '',
    expectedVersion: row?.profileVersion, password: '', confirmation: '',
  }
}

async function save() {
  if (saving.value || invalidDraft.value) return
  const current = draft.value
  saving.value = true
  error.value = ''
  try {
    if (current.mode === 'password') await api.resetPassword(current.id, current.password)
    else await api.save(current.id, {
      username: current.username, realName: current.realName,
      ...(current.mode === 'create' ? { password: current.password } : { expectedVersion: current.expectedVersion }),
    })
    if (disposed) return
    notice.value = current.mode === 'password' ? 'Password reset. The employee must sign in again.' : 'Employee saved.'
    clearDraft()
    await refresh()
  } catch (failure) {
    if (!disposed) report(failure)
  } finally {
    saving.value = false
  }
}

async function action(row, operation) {
  if (saving.value || loading.value) return
  if (operation !== 'invite') {
    const descriptions = {
      disable: 'Deactivate ' + row.username + '? Active sessions end and unfinished stocktakes return to pending.',
      unbind: 'Unbind the device for ' + row.username + '? Their sessions and outstanding pairing code will be revoked.',
      signout: 'Force ' + row.username + ' to sign out? Their paired device remains authorized.',
    }
    try { await ElMessageBox.confirm(descriptions[operation], 'Confirm employee action', { type: 'warning' }) }
    catch { return }
  }
  if (disposed) return
  saving.value = true
  error.value = ''
  notice.value = ''
  closeQr()
  try {
    if (operation === 'disable') await api.disable(row.id)
    else {
      const result = await api.pairing(row.id, operation)
      if (operation === 'invite' && !disposed) {
        const state = await api.clock()
        if (disposed) return
        const remaining = Date.parse(result.invitation.expiresAt) - Date.parse(state.serverTime)
        if (!Number.isFinite(remaining) || remaining <= 0) throw Error('PAIRING_EXPIRED')
        const bytes = Uint8Array.from(atob(result.qrPng), character => character.charCodeAt(0))
        const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
        qr.value = { url, username: row.username, expiresAt: result.invitation.expiresAt }
        expiryTimer = setTimeout(() => { closeQr(); notice.value = 'The pairing code expired. Generate a new code.' }, remaining)
        return
      }
    }
    if (disposed) return
    notice.value = operation === 'disable' ? 'Employee deactivated.' : operation === 'unbind' ? 'Device unbound.' : 'Employee signed out.'
    await refresh()
  } catch (failure) {
    if (!disposed) report(failure)
  } finally {
    saving.value = false
  }
}

onMounted(refresh)
onUnmounted(() => { disposed = true; request?.abort(); closeQr(); clearDraft() })
</script>

<template>
  <section v-loading="loading">
    <h1>Employees and devices</h1>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-alert v-if="notice" :title="notice" type="success" :closable="false" />
    <div class="team-toolbar">
      <el-button :disabled="loading || saving" @click="refresh">Refresh employees</el-button>
      <el-button type="primary" :disabled="loading || saving" @click="edit(null)">Add employee</el-button>
      <el-button v-if="administratorMobilePairing" :disabled="loading || saving" @click="administratorQrFailed = false; administratorQr = true">Connect administrator phone</el-button>
    </div>
    <p v-if="pairingEnabled">Unbind the current device before authorizing a replacement. Force sign-out preserves its device binding.</p>
    <el-table :data="employees" empty-text="No employees">
      <el-table-column prop="realName" label="Full name" min-width="160" />
      <el-table-column prop="username" label="Username" min-width="140" />
      <el-table-column label="Status" width="100"><template #default="{ row }">{{ row.active ? 'Active' : 'Inactive' }}</template></el-table-column>
      <el-table-column label="Actions" min-width="520"><template #default="{ row }">
        <div class="team-actions">
          <el-button :disabled="loading || saving" @click="edit(row)">Edit employee</el-button>
          <el-button :disabled="loading || saving" @click="edit(row, 'password')">Reset password</el-button>
          <el-button type="danger" :disabled="loading || saving || !row.active" @click="action(row, 'disable')">Deactivate</el-button>
          <template v-if="pairingEnabled">
            <el-button :disabled="loading || saving || !row.active" @click="action(row, 'invite')">Pairing QR</el-button>
            <el-button :disabled="loading || saving || !row.active" @click="action(row, 'signout')">Force sign-out</el-button>
            <el-button :disabled="loading || saving || !row.active" @click="action(row, 'unbind')">Unbind device</el-button>
          </template>
        </div>
      </template></el-table-column>
    </el-table>
    <el-dialog :model-value="!!draft" :title="draft?.mode === 'password' ? 'Reset employee password' : draft?.id ? 'Edit employee' : 'Add employee'" :close-on-click-modal="false" :before-close="done => { if (!saving) { clearDraft(); done() } }">
      <el-form v-if="draft" label-position="top" @submit.prevent="save">
        <template v-if="draft.mode !== 'password'">
          <el-form-item label="Full name"><el-input v-model="draft.realName" maxlength="128" :disabled="saving" /></el-form-item>
          <el-form-item label="Username"><el-input v-model="draft.username" maxlength="64" autocomplete="off" :disabled="saving" /></el-form-item>
        </template>
        <template v-if="draft.mode !== 'edit'">
          <p>Use 6 to 128 characters. Enter the new password twice.</p>
          <el-form-item label="Password"><el-input v-model="draft.password" type="password" show-password maxlength="128" autocomplete="new-password" :disabled="saving" /></el-form-item>
          <el-form-item label="Confirm password"><el-input v-model="draft.confirmation" type="password" show-password maxlength="128" autocomplete="new-password" :disabled="saving" /></el-form-item>
        </template>
        <el-alert v-if="error" :title="error" type="error" :closable="false" />
        <el-button native-type="submit" type="primary" :loading="saving" :disabled="invalidDraft">Save employee</el-button>
        <el-button :disabled="saving" @click="clearDraft">Cancel</el-button>
      </el-form>
    </el-dialog>
    <el-dialog v-model="administratorQr" title="Connect administrator phone">
      <template v-if="administratorQr">
        <p>In LEE T Mobile, choose Administrator sign-in and scan this code. Then sign in with your administrator account.</p>
        <el-alert v-if="administratorQrFailed" title="Could not load the code. Close this window and try again." type="error" :closable="false" />
        <img v-else class="pairing-image" :src="administratorQrUrl" alt="Administrator warehouse connection QR" width="320" height="320" @error="administratorQrFailed = true">
      </template>
    </el-dialog>
    <el-dialog :model-value="!!qr" title="Employee pairing QR" :close-on-click-modal="false" :before-close="done => { closeQr(); done() }">
      <template v-if="qr">
        <p>Scan with the intended employee device, then sign in as {{ qr.username }}.</p>
        <p>This code is single-use and expires at {{ new Date(qr.expiresAt).toLocaleTimeString() }}.</p>
        <img class="pairing-image" :src="qr.url" alt="Employee pairing QR" width="320" height="320">
        <p><el-button @click="closeQr">Close pairing QR</el-button></p>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.team-toolbar { display: flex; flex-wrap: wrap; gap: 12px; margin: 18px 0; }
.team-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.team-actions .el-button { margin-left: 0; }
.pairing-image { display: block; max-width: 100%; height: auto; margin: 16px auto; }
</style>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { createBackupClient } from './backup-api.mjs'

const emit = defineEmits(['changed','restored'])
const api = createBackupClient()
const data = ref(null)
const config = ref(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const upload = ref(null)
const file = ref(null)
const fileInput = ref(null)
const restoreUnconfirmed = ref(false)
let disposed = false
const controller = new AbortController()
const kinds = { manual:'Manual',automatic:'Automatic',pre_cleanup:'Before history cleanup',pre_restore:'Before restore' }
const messages = { LOGIN_REQUIRED:'Please sign in to LEE T again.',ADMIN_REQUIRED:'An Administrator account is required.',BACKUP_CONFIG_VERSION_CONFLICT:'Backup settings changed on another device. Refresh before editing again.',INVALID_BACKUP_PATH:'Choose two existing absolute backup folders outside the data folder.',DISTINCT_BACKUP_PATHS_REQUIRED:'The primary and fallback folders must be different.',INVALID_UPLOAD_LIMIT:'The upload limit must be between 1 MB and 1 TB.',LAST_VALID_BACKUP:'The last valid backup cannot be deleted.',BACKUP_NOT_FOUND:'This backup is no longer available.',BACKUP_TOO_LARGE:'The selected file exceeds the upload limit.',BACKUP_CHECKSUM:'The backup failed integrity verification.',INVALID_BACKUP:'This is not a compatible warehouse backup.',SPACE_FULL:'Backup storage is full. Free space on the configured backup drives and try again.',BACKUP_FAILED:'Backup failed. Check folders, permissions and available storage.',PATH_UNAVAILABLE:'A backup folder is unavailable. Reconnect the drive or review the paths.',PATH_PERMISSION:'The service cannot write to the backup folder.',BACKUP_PATHS_FULL:'Both backup paths are full. Complete a successful backup to resume Administrator operations.' }
function report(failure) { error.value = messages[failure.code] || messages[failure.message] || 'The operation could not be confirmed. Refresh the backup list before retrying.' }
async function load() {
  loading.value = true
  try {
    const result = await api.list(controller.signal)
    if (!disposed) { data.value = result; config.value = {...result.config,path1:result.config.path1 || '',path2:result.config.path2 || ''} }
  } catch (failure) { if (!disposed) report(failure) }
  finally { loading.value = false }
}
async function run(action,message) {
  if (busy.value || loading.value) return
  busy.value = true; error.value = ''; notice.value = ''
  try { await action(); if (!disposed) notice.value = message }
  catch (failure) { if (!disposed) report(failure) }
  finally { if (!disposed) { await load(); emit('changed') } busy.value = false }
}
async function confirm(message,title,twice = false) {
  try { await ElMessageBox.confirm(message,title,{type:'warning'}); if (twice) await ElMessageBox.confirm('Confirm this action again.','Final confirmation',{type:'warning'}); return !disposed } catch { return false }
}
async function remove(row) {
  if (await confirm('Delete this backup? The last valid backup is protected.','Confirm backup deletion')) await run(() => api.remove(row.id),'Backup deleted.')
}
async function maintenance() {
  if (await confirm('Change maintenance mode? Unsubmitted stocktakes restart and unsaved stock lists are cleared.','Confirm maintenance change',true)) await run(() => api.maintenance(!data.value.state.maintenance),'Maintenance updated.')
}
function chooseFile(event) { file.value = event.target.files[0] || null; upload.value = null; error.value = ''; if (file.value && file.value.size > data.value.config.uploadLimit) { file.value = null; event.target.value = ''; error.value = 'The selected file exceeds the upload limit.' } }
async function uploadFile() {
  if (!file.value) return
  const selected = file.value
  await run(async () => { const result = await api.upload(selected); if (!disposed) { upload.value = result; file.value = null; if (fileInput.value) fileInput.value.value = '' } },'Uploaded backup verified.')
}
async function restore(id,uploaded) {
  if (busy.value || restoreUnconfirmed.value) return
  if (!await confirm('Replace all accounts, stock, reports, tasks and photos with this backup? Later changes will be discarded. The current warehouse is preserved first. Everyone must sign in again.','Restore entire system',true)) return
  busy.value = true; error.value = ''; notice.value = ''
  try { await api.restore(id,uploaded); if (!disposed) emit('restored') }
  catch (failure) {
    if (!disposed) {
      if (!failure.code || failure.code === 'INTERNAL_ERROR') { restoreUnconfirmed.value = true; error.value = 'Restore result is unconfirmed. Sign out and sign in again, then verify the warehouse data. Do not repeat the restore.' }
      else report(failure)
    }
  } finally { busy.value = false }
}
onMounted(load)
onUnmounted(() => { disposed = true; controller.abort(); file.value = null })
</script>

<template>
  <section v-loading="loading" class="backups-panel">
    <div class="backup-heading"><div><h1>Backup and restore</h1><p>Protect warehouse accounts, stock, reports and photos.</p></div><el-button :disabled="loading || busy" @click="error=''; load()">Refresh backups</el-button></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" /><el-alert v-if="notice" :title="notice" type="success" :closable="false" />
    <el-alert v-if="busy" title="Processing and verifying warehouse data. Keep this window open." type="info" :closable="false" />
    <template v-if="data && config">
      <el-alert v-if="data.state.admin_backup_required" title="Backup storage is full. Administrator operations are limited to this page until a new backup succeeds." type="warning" :closable="false" />
      <el-alert v-if="data.config.warning" title="Automatic backup needs attention. Check backup paths, permissions and storage." type="warning" :closable="false" />
      <div class="backup-actions"><a href="/api/backups/download-full" download class="backup-download" :class="{disabled:busy}" @click="busy && $event.preventDefault()">Download full backup</a><el-button :disabled="busy" type="primary" @click="run(() => api.create(),'Backup created and verified.')">Back up now</el-button><el-button :disabled="busy" @click="maintenance">{{ data.state.maintenance ? 'End maintenance' : 'Start maintenance' }}</el-button><el-tag :type="data.state.maintenance ? 'warning' : 'success'">{{ data.state.maintenance ? 'Maintenance active' : 'Warehouse available' }}</el-tag></div>
      <p class="backup-hint">Downloaded backups contain account and business data. Save them in a protected location.</p>
      <el-collapse class="backup-settings"><el-collapse-item title="Advanced automatic backup settings" name="settings"><el-form v-if="config" label-position="top" @submit.prevent="run(() => api.configure({path1:config.path1,path2:config.path2,uploadLimit:config.uploadLimit,expectedRevision:config.revision}),'Backup settings saved.')"><div class="backup-config-grid"><el-form-item label="Primary backup folder"><el-input v-model="config.path1" aria-label="Primary backup folder" :disabled="busy" /></el-form-item><el-form-item label="Fallback / external folder"><el-input v-model="config.path2" aria-label="Fallback backup folder" :disabled="busy" /></el-form-item></div><el-form-item label="Maximum upload size (bytes)"><el-input-number v-model="config.uploadLimit" :min="1048576" :max="1099511627776" :precision="0" :disabled="busy" /></el-form-item><p class="backup-hint">These are folders on the warehouse server. Clearing both paths turns off scheduled backups.</p><el-button type="primary" native-type="submit" :disabled="busy">Save backup settings</el-button></el-form></el-collapse-item></el-collapse>
      <div class="backup-upload"><h2>Restore from a file</h2><p class="backup-hint">Upload a full .whb backup for integrity verification before restoring.</p><input ref="fileInput" type="file" accept=".whb" aria-label="Choose backup file" :disabled="busy" @change="chooseFile"><el-button :disabled="busy || !file" @click="uploadFile">Upload and verify</el-button><el-button :disabled="busy" @click="run(async () => { await api.cleanUploads(); upload = null },'Uploaded packages cleared.')">Clear uploaded packages</el-button><div v-if="upload" class="verified-upload"><el-tag type="success">Verified</el-tag><span>{{ new Date(upload.snapshotAt).toLocaleString('en-GB',{timeZone:'Asia/Kuala_Lumpur'}) }} · {{ upload.bytes.toLocaleString() }} bytes</span><el-button type="danger" :disabled="busy || restoreUnconfirmed" @click="restore(upload.id,true)">Restore uploaded backup</el-button></div></div>
      <h2>Saved backups</h2><el-table :data="data.backups" empty-text="No saved backups"><el-table-column label="Type" min-width="160"><template #default="{row}">{{ kinds[row.kind] || row.kind }}</template></el-table-column><el-table-column label="Snapshot (GMT+8)" min-width="190"><template #default="{row}">{{ new Date(row.snapshot_at).toLocaleString('en-GB',{timeZone:'Asia/Kuala_Lumpur'}) }}</template></el-table-column><el-table-column label="Size" min-width="100"><template #default="{row}">{{ row.bytes.toLocaleString() }} B</template></el-table-column><el-table-column prop="path" label="Server file" min-width="220" show-overflow-tooltip /><el-table-column label="Status" width="110"><template #default="{row}"><el-tag :type="row.missing ? 'danger' : 'success'">{{ row.missing ? 'Unavailable' : 'Saved' }}</el-tag></template></el-table-column><el-table-column label="Actions" min-width="250"><template #default="{row}"><div class="backup-row-actions"><a v-if="!row.missing" :href="'/api/backups/' + encodeURIComponent(row.id)" :class="{disabled:busy}" @click="busy && $event.preventDefault()">Download</a><el-button v-if="!row.missing" :disabled="busy || restoreUnconfirmed" @click="restore(row.id,false)">Restore</el-button><el-button type="danger" :disabled="busy" @click="remove(row)">Delete backup</el-button></div></template></el-table-column></el-table>
    </template>
  </section>
</template>

<style scoped>
.backup-heading { display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:24px; }.backup-heading p,.backup-hint { color:#8290a6;font-size:13px;line-height:1.7; }.backup-actions,.backup-row-actions { display:flex;align-items:center;flex-wrap:wrap;gap:12px; }.backup-actions { margin-top:22px; }.backup-download { display:inline-block;padding:9px 16px;border-radius:8px;background:#245de9;color:white;text-decoration:none;font-size:12px; }.disabled { pointer-events:none;opacity:.5; }.backup-row-actions a { color:#245de9;font-size:12px;text-decoration:none; }.backup-row-actions .el-button { margin:0; }.backup-settings { margin:24px 0; }.backup-config-grid { display:grid;grid-template-columns:1fr 1fr;gap:22px; }.backup-upload { border:1px solid #e6ebf3;border-radius:10px;padding:22px;margin-bottom:28px;background:#f8faff; }.backup-upload>input { font-size:12px;max-width:100%;margin:0 16px 16px 0; }.verified-upload { display:flex;align-items:center;flex-wrap:wrap;gap:14px;margin-top:20px;font-size:12px;color:#74829a; }.backups-panel h2 { font-size:15px;font-weight:600; }
@media(max-width:720px) { .backup-heading { align-items:flex-start;flex-direction:column; }.backup-config-grid { grid-template-columns:1fr;gap:0; } }
</style>

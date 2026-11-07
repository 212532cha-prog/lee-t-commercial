<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { createProfileClient } from './profile-api.mjs'

const emit = defineEmits(['signed-out'])
const api = createProfileClient()
const user = ref(null)
const name = ref('')
const file = ref(null)
const fileInput = ref(null)
const oldPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
let disposed = false
const controller = new AbortController()
const messages = { LOGIN_REQUIRED:'Please sign in to LEE T again.',ADMIN_REQUIRED:'An Administrator account is required.',PROFILE_VERSION_CONFLICT:'Your profile changed on another device. Refresh the profile before editing again.',INVALID_NAME:'Enter a name of up to 128 characters.','INVALID_PASSWORD':'Use a password of 6 to 128 characters.',INVALID_CREDENTIALS:'The current password is incorrect.',PHOTO_TOO_LARGE:'Choose a JPG or PNG image up to 5 MB.',INVALID_PHOTO:'The image could not be accepted. Choose a valid JPG or PNG.',MAINTENANCE:'Profile changes are paused during maintenance.',ADMIN_BACKUP_REQUIRED:'Backup storage needs attention before changing the profile.' }
function report(failure) { error.value = messages[failure.code] || messages[failure.message] || 'The result could not be confirmed. Refresh your profile before retrying.' }
async function load() {
  loading.value = true
  error.value = ''
  try { const result = await api.get(controller.signal); if (!disposed) { user.value = result; name.value = result.realName } }
  catch (failure) { if (!disposed) report(failure) }
  finally { loading.value = false }
}
async function change(action,message) {
  if (saving.value || loading.value) return
  saving.value = true; error.value = ''; notice.value = ''
  try { await action(); if (!disposed) { await load(); notice.value = message; file.value = null; if (fileInput.value) fileInput.value.value = '' } }
  catch (failure) { if (!disposed) report(failure) }
  finally { saving.value = false }
}
function selectFile(event) {
  file.value = null
  error.value = ''
  const selected = event.target.files[0]
  if (!selected) return
  if (!['image/jpeg','image/png'].includes(selected.type) || selected.size > 5*1024*1024) { error.value = 'Choose a JPG or PNG image up to 5 MB.'; event.target.value = ''; return }
  file.value = selected
}
async function removeAvatar() {
  try { await ElMessageBox.confirm('Remove the Administrator avatar?','Confirm avatar removal',{type:'warning'}) } catch { return }
  if (!disposed) await change(() => api.removeAvatar(),'Avatar removed.')
}
async function passwordChange() {
  if (saving.value || loading.value) return
  error.value = ''; notice.value = ''
  if (newPassword.value !== confirmPassword.value) { error.value = 'The new passwords do not match.'; return }
  saving.value = true
  try { await api.password(oldPassword.value,newPassword.value); if (!disposed) emit('signed-out') }
  catch (failure) { if (!disposed) report(failure) }
  finally { oldPassword.value = ''; newPassword.value = ''; confirmPassword.value = ''; saving.value = false }
}
onMounted(load)
onUnmounted(() => { disposed = true; controller.abort(); oldPassword.value = ''; newPassword.value = ''; confirmPassword.value = ''; file.value = null })
</script>

<template>
  <section v-loading="loading" class="profile-panel">
    <div class="profile-heading"><div><h1>My account</h1><p>Manage your Administrator profile and sign-in security.</p></div><el-button :disabled="loading || saving" @click="load">Refresh profile</el-button></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" /><el-alert v-if="notice" :title="notice" type="success" :closable="false" />
    <div v-if="user" class="profile-grid">
      <div class="profile-identity"><div class="avatar-frame"><img v-if="user.hasAvatar" :src="'/api/me/avatar?version=' + user.profileVersion" alt="Administrator avatar"><span v-else>A</span></div><strong>Administrator</strong><p>{{ user.username }}</p><label class="avatar-picker">JPG or PNG, up to 5 MB<input ref="fileInput" type="file" accept="image/jpeg,image/png" aria-label="Choose avatar" :disabled="saving" @change="selectFile"></label><el-button :disabled="saving || !file" @click="change(() => api.avatar(file),'Avatar updated.')">Upload avatar</el-button><el-button v-if="user.hasAvatar" :disabled="saving" @click="removeAvatar">Remove avatar</el-button></div>
      <div>
        <el-form class="profile-name" label-position="top" @submit.prevent="change(() => api.save(name,user.profileVersion),'Profile saved.')"><h2>Profile details</h2><el-form-item label="Display name"><el-input v-model="name" maxlength="128" aria-label="Display name" :disabled="saving" /></el-form-item><el-button type="primary" native-type="submit" :disabled="saving || !name.trim()">Save profile</el-button></el-form>
        <el-form class="profile-password" label-position="top" @submit.prevent="passwordChange"><h2>Change password</h2><p>Changing the password signs out all Administrator devices.</p><el-form-item label="Current password"><el-input v-model="oldPassword" aria-label="Current password" type="password" autocomplete="current-password" maxlength="128" show-password :disabled="saving" /></el-form-item><el-form-item label="New password"><el-input v-model="newPassword" aria-label="New password" type="password" autocomplete="new-password" minlength="6" maxlength="128" show-password :disabled="saving" /></el-form-item><el-form-item label="Confirm new password"><el-input v-model="confirmPassword" aria-label="Confirm new password" type="password" autocomplete="new-password" maxlength="128" show-password :disabled="saving" /></el-form-item><el-button type="primary" native-type="submit" :disabled="saving || !oldPassword || newPassword.length < 6 || !confirmPassword">Change password</el-button></el-form>
      </div>
    </div>
  </section>
</template>

<style scoped>
.profile-heading { display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:24px; }.profile-heading p,.profile-password p { font-size:13px;color:#8290a6;line-height:1.7; }.profile-grid { display:grid;grid-template-columns:250px minmax(0,480px);gap:42px; }.profile-identity { border:1px solid #e6ebf3;background:#f8faff;border-radius:10px;padding:26px;display:flex;flex-direction:column;align-items:center;gap:14px;align-self:start; }.profile-identity p { margin:0;color:#8290a6;font-size:12px; }.profile-identity .el-button { margin:0;width:100%; }.avatar-frame { width:84px;height:84px;border-radius:50%;overflow:hidden;background:#e9effd;color:#245de9;display:grid;place-items:center;font-size:32px; }.avatar-frame img { width:100%;height:100%;object-fit:cover; }.avatar-picker { color:#8290a6;font-size:11px;line-height:1.7;width:100%; }.avatar-picker input { width:100%;margin-top:8px;font-size:11px; }.profile-name h2,.profile-password h2 { font-size:15px;margin:0 0 22px; }.profile-password { margin-top:34px;padding-top:28px;border-top:1px solid #e6ebf3; }
@media(max-width:850px) { .profile-grid { grid-template-columns:1fr;gap:28px; }.profile-heading { align-items:flex-start;flex-direction:column; } }
</style>

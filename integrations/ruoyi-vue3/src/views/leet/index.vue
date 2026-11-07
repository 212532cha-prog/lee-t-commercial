<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import Team from './Team.vue'
import MasterData from './MasterData.vue'
import Products from './Products.vue'
import Counts from './Counts.vue'
import Costs from './Costs.vue'
import { createDashboardClient, formatCost } from './dashboard-api.mjs'
import { loadWarehouseDashboard, createAdminTransport } from './warehouse-api.mjs'

const api = createAdminTransport()
const dashboardApi = createDashboardClient()
const marking = ref(false)
const section = ref('overview')
const dashboard = ref(null)
const busy = ref(false)
const signingIn = ref(false)
const error = ref('')
const needsLogin = ref(false)
const hasSession = ref(false)
const username = ref('')
const password = ref('')
let activeRequest
const navigation = { overview: 'Overview', products: 'Products', masters: 'Master data', counts: 'Stocktakes', costs: 'Product costs', team: 'Employees and devices' }
const statistics = [
  ['productCount', 'Product types'], ['quantity', 'Total stock quantity'],
  ['totalValue', 'Total stock cost (RM)'], ['negativeCount', 'Negative-stock products'],
]
const messages = {
  LOGIN_REQUIRED: 'Please sign in to LEE T.',
  ADMIN_REQUIRED: 'An Administrator account is required.',
  INVALID_CREDENTIALS: 'The username or password is incorrect, or the account is inactive.',
  EMPLOYEE_PAIRING_REQUIRED: 'Use an Administrator account for this workspace.',
  TOO_MANY_ATTEMPTS: 'Too many sign-in attempts. Wait a moment and try again.',
}

async function refresh() {
  const request = new AbortController()
  activeRequest?.abort()
  activeRequest = request
  busy.value = true
  dashboard.value = null
  error.value = ''
  try {
    const result = await loadWarehouseDashboard({ signal: request.signal })
    if (!request.signal.aborted) {
      dashboard.value = result
      needsLogin.value = false
      hasSession.value = true
    }
  } catch (failure) {
    if (!request.signal.aborted) {
      needsLogin.value = failure.message === 'LOGIN_REQUIRED'
      hasSession.value = failure.message === 'ADMIN_REQUIRED'
      error.value = messages[failure.message] || 'The warehouse is unavailable. Please retry.'
    }
  } finally {
    if (activeRequest === request) busy.value = false
  }
}

async function signIn() {
  if (signingIn.value || !username.value.trim() || !password.value) return
  signingIn.value = true
  error.value = ''
  try {
    await api.read('/api/auth/login', { method: 'POST', data: { username: username.value, password: password.value } })
    section.value = 'overview'
    await refresh()
  } catch (failure) {
    needsLogin.value = true
    error.value = messages[failure.code] || messages[failure.message] || 'Sign-in could not be confirmed. Please retry.'
  } finally {
    password.value = ''
    signingIn.value = false
  }
}

async function signOut() {
  if (busy.value || signingIn.value) return
  busy.value = true
  try {
    const session = await api.read('/api/me')
    await api.read('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': session.csrf }, data: {} })
    dashboard.value = null
    hasSession.value = false
    needsLogin.value = true
    section.value = 'overview'
    error.value = messages.LOGIN_REQUIRED
  } catch (failure) {
    if (failure.message === 'LOGIN_REQUIRED') {
      dashboard.value = null
      hasSession.value = false
      needsLogin.value = true
      error.value = messages.LOGIN_REQUIRED
    } else error.value = 'Sign-out could not be confirmed. Please retry.'
  } finally { busy.value = false }
}

async function markRead(row) {
  if (marking.value || busy.value) return
  marking.value = true
  error.value = ''
  try {
    await dashboardApi.markRead(row.id, row.notificationToken)
    await refresh()
  } catch (failure) {
    error.value = failure.code === 'NOTIFICATION_CHANGED' ? 'This stock reminder changed. Refresh stock to see the latest alert.' : 'The read status could not be confirmed. Refresh stock and retry.'
  } finally { marking.value = false }
}

onMounted(refresh)
onUnmounted(() => { activeRequest?.abort(); password.value = '' })
</script>

<template>
  <div v-if="dashboard" class="warehouse-shell">
    <aside class="warehouse-sidebar">
      <div class="warehouse-brand"><b>LEE T<span class="brand-dot"></span></b><span>WAREHOUSE</span></div>
      <p class="nav-caption">WORKSPACE</p>
      <el-menu :default-active="section" @select="key => section = key">
        <el-menu-item v-for="(label, key) in navigation" :key="key" :index="key"><span>{{ label }}</span></el-menu-item>
      </el-menu>
      <div class="sidebar-footer">Inventory · Stocktakes · People</div>
    </aside>
    <div class="warehouse-main">
      <header class="warehouse-topbar"><span>{{ navigation[section] }}</span><div><span class="role-label">Administrator</span><el-button :disabled="busy" @click="signOut">Sign out</el-button></div></header>
      <main class="warehouse-content">
        <el-alert v-if="error" :title="error" type="error" :closable="false" />
        <Team v-if="section === 'team'" />
        <MasterData v-if="section === 'masters'" />
        <Products v-if="section === 'products'" />
        <Counts v-if="section === 'counts'" />
        <Costs v-if="section === 'costs'" />
        <template v-if="section === 'overview'">
          <div class="page-heading"><div><p class="eyebrow">WAREHOUSE OVERVIEW</p><h1>Warehouse overview</h1><p class="page-subtitle">Stock, reminders and recent activity.</p></div><el-button :disabled="busy" @click="refresh">Refresh stock</el-button></div>
          <div class="metrics-grid">
            <article v-for="([key, label], index) in statistics" :key="key" class="metric-card" :class="{ 'metric-warning': key === 'negativeCount' && dashboard.statistics[key] }">
              <span class="metric-index">0{{ index + 1 }}</span><p>{{ label }}</p><strong>{{ key === 'totalValue' ? formatCost(dashboard.statistics[key]) : dashboard.statistics[key] }}</strong>
            </article>
          </div>
          <div class="overview-grid">
            <section class="surface"><div class="surface-heading"><h2>Negative stock</h2><el-tag type="danger" effect="plain">{{ dashboard.negative.length }}</el-tag></div>
              <el-table :data="dashboard.negative" :max-height="320" empty-text="No negative stock"><el-table-column prop="productCode" label="Product code" min-width="130" /><el-table-column prop="name" label="Product" min-width="130" /><el-table-column prop="quantity" label="Stock" width="80" /><el-table-column label="Reminder" min-width="140"><template #default="{row}"><el-tag v-if="row.read" type="info">Read</el-tag><el-button v-else-if="row.notificationToken" :disabled="busy || marking" @click="markRead(row)">Mark as read</el-button></template></el-table-column></el-table>
            </section>
            <section class="surface"><div class="surface-heading"><h2>Reorder reminders</h2><el-tag type="warning" effect="plain">{{ dashboard.low.length }}</el-tag></div>
              <el-table :data="dashboard.low" :max-height="320" empty-text="No reorder reminders"><el-table-column prop="name" label="Product" /><el-table-column prop="quantity" label="Stock" width="90" /><el-table-column prop="minimumStock" label="Minimum" width="95" /></el-table>
            </section>
          </div>
          <section class="surface recent-activity"><div class="surface-heading"><h2>Recent activity</h2><span>Latest 10 entries</span></div>
            <el-table :data="dashboard.recent" empty-text="No recent activity">
              <el-table-column prop="name" label="Product" min-width="180" /><el-table-column label="Operation" min-width="110"><template #default="{row}">{{ {inbound:'Stock in',outbound:'Stock out',adjustment:'Adjustment'}[row.kind] }}</template></el-table-column>
              <el-table-column prop="quantityDelta" label="Change" width="90" /><el-table-column label="Time" min-width="180"><template #default="{row}">{{ new Date(row.time).toLocaleString('en-GB', {timeZone:'Asia/Kuala_Lumpur'}) }}</template></el-table-column>
            </el-table>
          </section>
        </template>
      </main>
    </div>
  </div>
  <main v-else class="welcome-shell" v-loading="busy">
    <section class="welcome-story"><div class="warehouse-brand"><b>LEE T<span class="brand-dot"></span></b><span>WAREHOUSE</span></div><div><p class="eyebrow">LOCAL WAREHOUSE SYSTEM</p><h1>Warehouse<br>management.</h1><p>Products, stock and people in one workspace.</p></div><span class="welcome-footnote">LEE T Warehouse</span></section>
    <section class="welcome-form">
      <p class="eyebrow">ADMINISTRATOR WORKSPACE</p><h2>{{ needsLogin ? 'Welcome back.' : 'Warehouse connection' }}</h2>
      <p v-if="needsLogin" class="page-subtitle">Sign in to manage your warehouse.</p>
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <el-form v-if="needsLogin" label-position="top" class="sign-in-form" @submit.prevent="signIn">
        <el-form-item label="Username"><el-input v-model="username" autocomplete="username" maxlength="64" :disabled="signingIn" /></el-form-item>
        <el-form-item label="Password"><el-input v-model="password" type="password" autocomplete="current-password" maxlength="128" show-password :disabled="signingIn" /></el-form-item>
        <el-button type="primary" native-type="submit" :loading="signingIn" :disabled="!username.trim() || !password">Sign in</el-button>
      </el-form>
      <el-button v-if="!needsLogin" :disabled="busy" @click="refresh">Retry connection</el-button>
      <el-button v-if="hasSession" :disabled="busy" @click="signOut">Sign out</el-button>
    </section>
  </main>
</template>

<style scoped>
:global(:root) { --el-color-primary:#245de9;--el-color-primary-light-3:#658cf0;--el-color-primary-light-5:#90aaf4;--el-color-primary-light-7:#bbcafd;--el-color-primary-light-8:#d5e0fb;--el-color-primary-light-9:#edf2ff;--el-color-primary-dark-2:#1c4cc2;--el-border-radius-base:8px;--el-font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
:global(.el-dialog) { border-radius:12px; }

.warehouse-shell,.welcome-shell { --el-color-primary:#245de9;--el-border-radius-base:8px;--el-font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-family:var(--el-font-family);color:#18273e; }
.warehouse-shell { min-height:100vh;background:#f3f6fb;display:grid;grid-template-columns:228px minmax(0,1fr); }
.warehouse-sidebar { position:sticky;top:0;height:100vh;max-height:100vh;overflow-y:auto;background:#fff;border-right:1px solid #e6ebf3;padding:34px 18px 24px;display:flex;flex-direction:column;min-height:100vh; }
.warehouse-brand { display:flex;flex-direction:column;gap:7px;padding:0 16px; }.warehouse-brand b { font-size:30px;letter-spacing:-1.8px;color:#152b4d;display:flex;align-items:baseline;gap:7px; }.warehouse-brand>span { font-size:10px;letter-spacing:3px;color:#7b879c; }.brand-dot { width:7px;height:7px;border-radius:50%;background:#2bb69e;display:inline-block; }
.nav-caption { margin:48px 16px 12px;font-size:10px;letter-spacing:1.5px;color:#8c97aa;font-weight:600; }.warehouse-sidebar :deep(.el-menu) { border:0;background:transparent; }.warehouse-sidebar :deep(.el-menu-item) { height:46px;line-height:46px;border-radius:8px;margin:4px 0;color:#65738a;font-size:13px; }.warehouse-sidebar :deep(.el-menu-item.is-active) { background:#edf2ff;color:#245de9;font-weight:600; }.sidebar-footer { margin-top:auto;padding:40px 16px 0;font-size:12px;line-height:1.8;color:#a0aabc; }
.warehouse-main { min-width:0; }.warehouse-topbar { height:76px;background:#fff;border-bottom:1px solid #e6ebf3;display:flex;align-items:center;justify-content:space-between;padding:0 34px;font-size:13px;font-weight:600; }.warehouse-topbar>div { display:flex;align-items:center;gap:22px; }.role-label { color:#8792a4;font-size:12px;font-weight:400; }.warehouse-content { padding:36px;max-width:1600px;margin:auto; }.warehouse-content>section:not(.surface) { background:#fff;border:1px solid #e6ebf3;border-radius:12px;padding:26px; }
:deep(h1) { margin:0 0 14px;font-size:28px;font-weight:650;letter-spacing:-.8px;line-height:1.3; }:global(.el-table) { --el-table-header-bg-color:#f8faff;--el-table-border-color:#edf0f6;--el-table-header-text-color:#768297;--el-table-text-color:#46546d;font-size:12px; }:global(.el-table th.el-table__cell) { font-size:11px;font-weight:600;height:46px; }:global(.el-table td.el-table__cell) { padding:12px 0; }:deep(.el-alert) { margin:14px 0; }:deep(.el-dialog) { border-radius:12px; }:global(.el-button) { font-size:12px; }
.page-heading { display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:28px; }.eyebrow { color:#8290a6;letter-spacing:1.8px;font-size:10px;font-weight:600;margin:0 0 14px; }.page-subtitle { color:#8290a6;font-size:13px;line-height:1.7;margin:0; }.page-heading h1 { font-size:34px;margin-bottom:9px; }.metrics-grid { display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;margin-bottom:24px; }.metric-card { background:white;border:1px solid #e6ebf3;border-radius:12px;padding:23px;position:relative;min-height:146px; }.metric-card p { font-size:12px;color:#8190a6;margin:14px 0 12px; }.metric-card strong { font-size:25px;font-weight:600;letter-spacing:-.6px;word-break:break-word; }.metric-index { font-size:10px;color:#b4c0d1;letter-spacing:1px; }.metric-warning { border-color:#f2d5d8; }.metric-warning strong { color:#c65867; }.overview-grid { display:grid;grid-template-columns:1fr 1fr;gap:24px; }.surface { background:#fff;border:1px solid #e6ebf3;border-radius:12px;padding:24px; }.surface-heading { display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px; }.surface-heading h2 { margin:0;font-size:14px;font-weight:600; }.surface-heading>span { font-size:11px;color:#99a4b5; }.recent-activity { margin-top:24px; }
.welcome-shell { min-height:100vh;display:grid;grid-template-columns:1fr 1fr;background:#fff; }.welcome-story { padding:52px 54px;background:#edf3fc;display:flex;flex-direction:column;justify-content:space-between; }.welcome-story .warehouse-brand { padding:0; }.welcome-story h1 { font-size:46px;letter-spacing:-2px;line-height:1.2; }.welcome-story>div>p:last-child { color:#7e8ca3;font-size:14px;line-height:1.8; }.welcome-footnote { font-size:11px;color:#94a0b2; }.welcome-form { max-width:420px;width:100%;padding:52px 36px;align-self:center;justify-self:center; }.welcome-form h2 { font-size:30px;letter-spacing:-1px;font-weight:600;margin:0 0 14px; }.sign-in-form { margin-top:28px; }.sign-in-form>.el-button { width:100%;height:42px; }
@media(max-width:1100px) { .metrics-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }.overview-grid { grid-template-columns:1fr; }.warehouse-content { padding:24px; }.warehouse-sidebar { padding-left:10px;padding-right:10px; }.warehouse-shell { grid-template-columns:210px minmax(0,1fr); } }
@media(max-width:720px) { .warehouse-shell { display:block; }.warehouse-sidebar { position:static;height:auto;max-height:none;min-height:auto;padding:20px;border-right:0;border-bottom:1px solid #e6ebf3; }.warehouse-brand { padding:0; }.nav-caption,.sidebar-footer { display:none; }.warehouse-sidebar :deep(.el-menu) { display:flex;flex-wrap:wrap;margin-top:20px; }.warehouse-sidebar :deep(.el-menu-item) { padding:0 14px;height:38px;line-height:38px;font-size:12px;margin:0; }.warehouse-topbar { padding:0 20px;height:64px; }.warehouse-content { padding:20px 14px; }.warehouse-content>section:not(.surface) { padding:18px; }.page-heading h1 { font-size:26px; }.metric-card { padding:18px; }.metric-card strong { font-size:21px; }.role-label { display:none; }.welcome-shell { grid-template-columns:1fr; }.welcome-story { padding:30px;min-height:260px;gap:40px; }.welcome-story h1 { font-size:34px; }.welcome-footnote { display:none; }.welcome-form { padding:36px 28px;max-width:100%; } }
</style>

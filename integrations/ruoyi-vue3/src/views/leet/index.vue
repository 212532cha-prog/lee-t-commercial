<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import Team from './Team.vue'
import MasterData from './MasterData.vue'
import Products from './Products.vue'
import { loadWarehouseDashboard } from './warehouse-api.mjs'

const section = ref('overview')
const dashboard = ref(null)
const busy = ref(false)
const error = ref('')
let activeRequest

const statistics = [
  ['productCount', 'Product types'],
  ['quantity', 'Total stock quantity'],
  ['totalValue', 'Total stock cost (RM)'],
  ['negativeCount', 'Negative-stock products'],
]

const messages = {
  LOGIN_REQUIRED: 'Please sign in to LEE T.',
  ADMIN_REQUIRED: 'An Administrator account is required.',
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
    if (!request.signal.aborted) dashboard.value = result
  } catch (failure) {
    if (!request.signal.aborted) error.value = messages[failure.message] || 'The warehouse is unavailable. Please retry.'
  } finally {
    if (activeRequest === request) busy.value = false
  }
}

onMounted(refresh)
onUnmounted(() => activeRequest?.abort())
</script>

<template>
  <main class="app-container" v-loading="busy">
    <h1>LEE T Warehouse</h1>
    <el-button v-if="section === 'overview'" :disabled="busy" @click="refresh">Refresh stock</el-button>
    <el-button v-if="error === messages.LOGIN_REQUIRED" tag="a" href="/">Sign in to LEE T</el-button>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-menu v-if="dashboard" mode="horizontal" :default-active="section" @select="key => section = key">
      <el-menu-item index="overview">Overview</el-menu-item>
      <el-menu-item index="products">Products</el-menu-item>
      <el-menu-item index="masters">Master data</el-menu-item>
      <el-menu-item index="team">Employees and devices</el-menu-item>
    </el-menu>
    <Team v-if="dashboard && section === 'team'" />
    <MasterData v-if="dashboard && section === 'masters'" />
    <Products v-if="dashboard && section === 'products'" />
    <template v-if="dashboard && section === 'overview'">
      <el-row :gutter="16">
        <el-col v-for="[key, label] in statistics" :key="key" :xs="12" :md="6">
          <el-card><span>{{ label }}</span><p>{{ dashboard.statistics[key] }}</p></el-card>
        </el-col>
      </el-row>
      <section>
        <h2>Negative stock</h2>
        <el-table :data="dashboard.negative" empty-text="No negative stock">
          <el-table-column prop="productCode" label="Product code" />
          <el-table-column prop="name" label="Product" />
          <el-table-column prop="quantity" label="Stock quantity" />
        </el-table>
      </section>
      <section>
        <h2>Reorder reminders</h2>
        <el-table :data="dashboard.low" empty-text="No reorder reminders">
          <el-table-column prop="productCode" label="Product code" />
          <el-table-column prop="name" label="Product" />
          <el-table-column prop="quantity" label="Stock quantity" />
          <el-table-column prop="minimumStock" label="Minimum stock" />
        </el-table>
      </section>
    </template>
  </main>
</template>

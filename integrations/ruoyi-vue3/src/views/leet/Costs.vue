<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { createDashboardClient, formatCost } from './dashboard-api.mjs'

const api = createDashboardClient()
const rows = ref([])
const cursor = ref(null)
const loading = ref(false)
const error = ref('')
let request

async function load(append = false) {
  request?.abort()
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  try {
    const result = await api.costs(append ? cursor.value : null, controller.signal)
    if (controller.signal.aborted) return
    rows.value = append ? [...rows.value, ...result.products] : result.products
    cursor.value = result.nextCursor
  } catch (failure) {
    if (!controller.signal.aborted) error.value = failure.message === 'LOGIN_REQUIRED' ? 'Please sign in to LEE T again.' : failure.message === 'ADMIN_REQUIRED' ? 'An Administrator account is required.' : 'Costs could not be loaded. Please retry.'
  } finally { if (request === controller) loading.value = false }
}
onMounted(() => load())
onUnmounted(() => request?.abort())
</script>

<template>
  <section v-loading="loading">
    <div class="cost-heading"><div><h1>Product costs</h1><p>Current quantities and costs in Malaysian ringgit.</p></div><el-button :disabled="loading" @click="load(false)">Refresh costs</el-button></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-table :data="rows" empty-text="No product costs" class="cost-table">
      <el-table-column prop="productCode" label="Product code" min-width="140" />
      <el-table-column prop="name" label="Product" min-width="200" />
      <el-table-column prop="quantity" label="Stock" min-width="100" align="right" />
      <el-table-column label="Individual cost" min-width="150" align="right"><template #default="{row}">{{ formatCost(row.individualCost) }}</template></el-table-column>
      <el-table-column label="Stock cost" min-width="160" align="right"><template #default="{row}">{{ formatCost(row.value) }}</template></el-table-column>
    </el-table>
    <el-button v-if="cursor" class="cost-more" :disabled="loading" @click="load(true)">Load more costs</el-button>
  </section>
</template>

<style scoped>
.cost-heading { display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:24px; }.cost-heading p { color:#8290a6;font-size:13px;line-height:1.7;margin:0; }.cost-more { margin-top:20px; }.cost-table { font-variant-numeric:tabular-nums; }
@media(max-width:720px) { .cost-heading { align-items:flex-start;flex-direction:column; } }
</style>

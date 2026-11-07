<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { loadWarehouseDashboard } from './warehouse-api.mjs'

const dashboard = ref(null)
const busy = ref(false)
const error = ref('')
let activeRequest

const statistics = [
  ['productCount', '商品种类'],
  ['quantity', '库存总数量'],
  ['totalValue', '库存总成本（RM）'],
  ['negativeCount', '负库存商品'],
]

const messages = {
  LOGIN_REQUIRED: '请先登录 LEE T 仓库后台。',
  ADMIN_REQUIRED: '此页面需要 LEE T 管理员账号。',
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
    if (!request.signal.aborted) error.value = messages[failure.message] || '仓库暂时无法连接，请重试。'
  } finally {
    if (activeRequest === request) busy.value = false
  }
}

onMounted(refresh)
onUnmounted(() => activeRequest?.abort())
</script>

<template>
  <main class="app-container" v-loading="busy">
    <h1>LEE T 仓库总览</h1>
    <el-button :disabled="busy" @click="refresh">刷新库存</el-button>
    <el-button v-if="error === messages.LOGIN_REQUIRED" tag="a" href="/">登录 LEE T</el-button>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <template v-if="dashboard">
      <el-row :gutter="16">
        <el-col v-for="[key, label] in statistics" :key="key" :xs="12" :md="6">
          <el-card><span>{{ label }}</span><p>{{ dashboard.statistics[key] }}</p></el-card>
        </el-col>
      </el-row>
      <section>
        <h2>负库存</h2>
        <el-table :data="dashboard.negative" empty-text="没有负库存">
          <el-table-column prop="productCode" label="商品编号" />
          <el-table-column prop="name" label="商品" />
          <el-table-column prop="quantity" label="库存数量" />
        </el-table>
      </section>
      <section>
        <h2>补货提醒</h2>
        <el-table :data="dashboard.low" empty-text="没有补货提醒">
          <el-table-column prop="productCode" label="商品编号" />
          <el-table-column prop="name" label="商品" />
          <el-table-column prop="quantity" label="库存数量" />
          <el-table-column prop="minimumStock" label="最低库存" />
        </el-table>
      </section>
    </template>
  </main>
</template>

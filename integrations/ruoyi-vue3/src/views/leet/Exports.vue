<script setup>
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { createExportClient, exportFields, exportInput } from './export-api.mjs'
import { locationPath } from './location-path.mjs'

const props = defineProps({ scope: { type: Object, default: null } })
const api = createExportClient()
const form = reactive({ format:'xlsx',sections:props.scope ? ['reports'] : ['inventory'],fields:['productCode','name','quantity','minimumStock'],categoryId:'',locationId:'',kind:'',from:'',to:'',productIds:[] })
const masters = ref({ categories:[],locations:[] })
const products = ref([])
const cursor = ref(null)
const loading = ref(false)
const submitting = ref(false)
const checking = ref(false)
const error = ref('')
const job = ref(null)
let disposed = false
let timer
const controller = new AbortController()
const messages = { LOGIN_REQUIRED:'Please sign in to LEE T again.',ADMIN_REQUIRED:'An Administrator account is required.',EXPORT_NOT_FOUND_OR_INVALIDATED:'This export expired or was invalidated. Generate a new file.',EXPORT_RESOURCE_CHANGED:'The selected data changed. Review the scope and generate a new file.',ADMIN_BACKUP_REQUIRED:'Backup storage needs attention before exporting.',MAINTENANCE:'Exporting is paused during maintenance.' }
const explain = failure => messages[failure.code] || messages[failure.message] || failure.message

async function load(append = false) {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const [refs, page] = await Promise.all([append ? Promise.resolve(masters.value) : api.masters(controller.signal),api.products(append ? cursor.value : null, controller.signal)])
    if (disposed) return
    masters.value = refs
    products.value = append ? [...products.value,...page.products] : page.products
    cursor.value = page.nextCursor
  } catch (failure) { if (!disposed) error.value = 'Export filters could not be loaded. Please retry. ' + explain(failure) }
  finally { loading.value = false }
}

async function check() {
  if (!job.value || checking.value || disposed) return
  clearTimeout(timer)
  checking.value = true
  error.value = ''
  try {
    const result = await api.status(job.value.id,controller.signal)
    if (disposed) return
    job.value = result
    if (['pending','running'].includes(result.status)) timer = setTimeout(check,1000)
    if (result.status === 'failed') error.value = 'File generation failed. ' + (messages[result.error] || result.error || 'Review the filters and retry.')
  } catch (failure) {
    if (!disposed) {
      error.value = 'Export status could not be confirmed. ' + explain(failure)
      if (failure.code === 'EXPORT_NOT_FOUND_OR_INVALIDATED') job.value = { ...job.value, status:'failed' }
    }
  }
  finally { checking.value = false }
}

async function generate() {
  if (submitting.value || ['pending','running'].includes(job.value?.status)) return
  error.value = ''
  let input
  try { input = exportInput(form,props.scope) } catch (failure) { error.value = failure.message; return }
  submitting.value = true
  clearTimeout(timer)
  try {
    const result = await api.create(input)
    if (disposed) return
    job.value = result
    await check()
  } catch (failure) { if (!disposed) error.value = 'The export request could not be confirmed. ' + explain(failure) }
  finally { submitting.value = false }
}

onMounted(() => load())
onUnmounted(() => { disposed = true; controller.abort(); clearTimeout(timer) })
</script>

<template>
  <section v-loading="loading" class="exports-panel">
    <div class="export-heading"><div><h1>Data export</h1><p>Generate a snapshot as Excel or PDF. Downloaded files contain warehouse data.</p></div><el-button :disabled="loading" @click="load(false)">Refresh export filters</el-button></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-alert v-if="scope" :title="'Selected count report: ' + scope.reportCode + (scope.trashed ? ' (trash)' : '')" type="info" :closable="false" />
    <el-form label-position="top" class="export-form" @submit.prevent="generate">
      <el-form-item label="File format"><el-select v-model="form.format" aria-label="File format"><el-option label="Excel (.xlsx)" value="xlsx" /><el-option label="PDF" value="pdf" /></el-select></el-form-item>
      <fieldset><legend>Data sections</legend><label v-for="(label,key) in {inventory:'Product inventory',history:'Stock history',reports:'Count reports',costs:'Product costs'}" :key="key"><input v-model="form.sections" type="checkbox" :value="key">{{ label }}</label></fieldset>
      <fieldset v-if="form.sections.includes('inventory')"><legend>Inventory fields</legend><label v-for="(label,key) in exportFields" :key="key"><input v-model="form.fields" type="checkbox" :value="key">{{ label }}</label></fieldset>
      <div class="export-grid">
        <el-form-item label="Category"><el-select v-model="form.categoryId" clearable filterable aria-label="Export category"><el-option v-for="row in masters.categories" :key="row.id" :value="row.id" :label="row.name" /></el-select></el-form-item>
        <el-form-item label="Location"><el-select v-model="form.locationId" clearable filterable aria-label="Export location"><el-option v-for="row in masters.locations" :key="row.id" :value="row.id" :label="locationPath(row.id,masters.locations)" /></el-select></el-form-item>
        <el-form-item label="From date (GMT+8)"><input v-model="form.from" type="date" aria-label="From date" /></el-form-item>
        <el-form-item label="Through date (GMT+8)"><input v-model="form.to" type="date" aria-label="Through date" /></el-form-item>
        <el-form-item label="History type"><el-select v-model="form.kind" clearable aria-label="Export history type"><el-option label="Stock in" value="inbound" /><el-option label="Stock out" value="outbound" /><el-option label="Adjustment" value="adjustment" /></el-select></el-form-item>
      </div>
      <el-form-item label="Selected products (leave empty for all)"><el-select v-model="form.productIds" multiple filterable collapse-tags :multiple-limit="1000" aria-label="Export products"><el-option v-for="row in products" :key="row.id" :value="row.id" :label="row.productCode + ' · ' + row.name" /></el-select></el-form-item>
      <el-button v-if="cursor" :disabled="loading" @click="load(true)">Load more export products</el-button>
      <div class="export-submit"><el-button type="primary" native-type="submit" :disabled="submitting || ['pending','running'].includes(job?.status)" :loading="submitting">Generate file</el-button><span>Files expire after 30 minutes. Deleting related data may invalidate them.</span></div>
    </el-form>
    <div v-if="job" class="export-status" role="status"><strong>{{ {pending:'Export queued',running:'Generating file',ready:'File ready',failed:'Export failed'}[job.status] }}</strong><p>Rows processed: {{ job.processed || 0 }}</p><p v-if="job.expiresAt">Available until {{ new Date(job.expiresAt).toLocaleString('en-GB',{timeZone:'Asia/Kuala_Lumpur'}) }} (GMT+8)</p><a v-if="job.status === 'ready'" :href="'/api/exports/' + encodeURIComponent(job.id) + '/download'" class="export-download">Download file</a><el-button :disabled="checking" @click="check">Check export status</el-button></div>
  </section>
</template>

<style scoped>
.export-heading { display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:24px; }.export-heading p,.export-submit span { color:#8290a6;font-size:13px;line-height:1.7; }.export-form { max-width:920px; }.export-grid { display:grid;grid-template-columns:1fr 1fr;gap:0 24px; }.export-form fieldset { border:1px solid #e6ebf3;border-radius:8px;margin:0 0 24px;padding:16px;display:flex;flex-wrap:wrap;gap:14px 22px; }.export-form legend { color:#52637c;font-size:12px;padding:0 8px; }.export-form fieldset label { display:flex;align-items:center;gap:7px;font-size:12px;color:#52637c; }.export-form input[type=date] { border:1px solid #dce2ec;border-radius:8px;padding:9px 12px;min-width:0;width:100%;color:#46546d;font:inherit; }.export-submit { display:flex;align-items:center;gap:20px;margin-top:24px; }.export-status { padding:22px;background:#f8faff;border:1px solid #e6ebf3;border-radius:10px;margin-top:28px; }.export-status p { font-size:12px;color:#74829a; }.export-download { display:inline-block;padding:9px 16px;background:#245de9;border-radius:8px;color:white;text-decoration:none;font-size:12px;margin-right:14px; }
@media(max-width:720px) { .export-heading,.export-submit { align-items:flex-start;flex-direction:column; }.export-grid { grid-template-columns:1fr; } }
</style>

<script setup>
import { onUnmounted, ref } from 'vue'
import { createProductAssetsClient } from './product-assets-api.mjs'

const props = defineProps({ categories:{type:Array,required:true},initialCategory:{type:String,default:''} })
const emit = defineEmits(['close','imported'])
const api = createProductAssetsClient()
const category = ref(props.initialCategory)
const file = ref(null)
const preview = ref(null)
const busy = ref(false)
const error = ref('')
let disposed = false
const rowMessages = { INVALID_NAME:'Enter a valid name.',INVALID_COST:'Use a valid nonnegative cost with up to two decimal places.',INVALID_MINIMUM:'Use a nonnegative whole minimum stock.',IMPORT_DUPLICATE_NAME:'This name already exists in the category or file.' }
const messages = { IMPORT_ROWS_CHANGED:'Products changed after preview. Preview the file again before importing.',IMPORT_PREVIEW_REQUIRED:'The file or category changed. Preview it again.',INVALID_IMPORT_HEADERS:'Keep the original template headers.',INVALID_PRODUCT_WORKBOOK:'Choose a valid Products Excel workbook.',IMPORT_FORMULA_NOT_ALLOWED:'Replace spreadsheet formulas with values before importing.',IMPORT_SHEET_LIMIT:'Use at most 200 rows in the supplied three-column template.',IMPORT_NO_ROWS:'The workbook has no product rows.',CATEGORY_NOT_FOUND:'This category is no longer available.' }
function changed() { preview.value = null; error.value = '' }
function choose(event) {
  changed(); file.value = event.target.files[0] || null
  if (file.value && file.value.size > 1024*1024) { file.value = null; event.target.value = ''; error.value = 'Choose an Excel file up to 1 MB.' }
}
async function run(commit = false) {
  if (busy.value || !category.value || !file.value || commit && !preview.value?.previewToken) return
  busy.value = true; error.value = ''
  const selectedFile = file.value, selectedCategory = category.value, token = preview.value?.previewToken
  try {
    const result = commit ? await api.commit(selectedCategory,selectedFile,token) : await api.preview(selectedCategory,selectedFile)
    if (disposed) return
    if (commit) emit('imported',result.products.length)
    else preview.value = result
  } catch (failure) {
    if (!disposed) {
      preview.value = null
      error.value = messages[failure.code] || (commit ? 'Import result is unconfirmed. Preview the file again to check existing products. Do not resubmit without a new preview.' : 'The file could not be previewed. Check the category and template, then retry.')
    }
  } finally { busy.value = false }
}
onUnmounted(() => { disposed = true; file.value = null; preview.value = null })
</script>

<template>
  <el-dialog :model-value="true" title="Import products" :close-on-click-modal="false" :before-close="done => { if (!busy) { emit('close'); done() } }">
    <p class="import-hint">Use the template, up to 200 rows and 1 MB. New products start with stock 0. Previewing never writes to inventory.</p>
    <a href="/api/products/import-template" download class="template-link">Download Excel template</a>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-form label-position="top" class="import-form" @submit.prevent="run(false)">
      <el-form-item label="Import category"><el-select v-model="category" aria-label="Import category" :disabled="busy" @change="changed"><el-option v-for="row in categories.filter(row=>!row.deleted)" :key="row.id" :value="row.id" :label="row.name" /></el-select></el-form-item>
      <el-form-item label="Excel workbook"><input type="file" accept=".xlsx" aria-label="Product import workbook" :disabled="busy" @change="choose"></el-form-item>
      <el-button native-type="submit" :disabled="busy || !category || !file" :loading="busy">Preview import</el-button>
    </el-form>
    <template v-if="preview">
      <h3>Preview</h3><p class="import-hint">{{ preview.rows.length }} valid rows · {{ preview.errors.length }} errors</p>
      <el-table :data="preview.rows" max-height="280" empty-text="No valid rows"><el-table-column prop="row" label="Row" width="70" /><el-table-column prop="full" label="Product" min-width="180" /><el-table-column prop="cost" label="Cost (RM)" width="110" /><el-table-column prop="minimum" label="Minimum" width="100" /></el-table>
      <ul class="import-errors"><li v-for="row in preview.errors" :key="row.row">Row {{ row.row }}: {{ rowMessages[row.error] || row.error }}</li></ul>
      <el-button v-if="preview.previewToken && !preview.errors.length" type="primary" :disabled="busy" @click="run(true)">Confirm import</el-button>
    </template>
    <template #footer><el-button :disabled="busy" @click="emit('close')">Close import</el-button></template>
  </el-dialog>
</template>

<style scoped>
.import-hint { color:#8290a6;font-size:13px;line-height:1.7; }.template-link { display:inline-block;color:#245de9;font-size:12px;text-decoration:none;margin:0 0 18px; }.import-form { margin-top:20px; }.import-form input { max-width:100%;font-size:12px; }.import-errors { color:#b75361;font-size:12px;line-height:1.8;padding-left:18px; }
</style>

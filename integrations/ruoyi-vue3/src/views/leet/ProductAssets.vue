<script setup>
import { onUnmounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { createProductAssetsClient } from './product-assets-api.mjs'

const props = defineProps({ product:{type:Object,required:true} })
const emit = defineEmits(['updated','busy'])
const api = createProductAssetsClient()
const busy = ref(false)
const error = ref('')
const file = ref(null)
const picker = ref(null)
const photoVersion = ref(Date.now())
let disposed = false
function choose(event) {
  file.value = event.target.files[0] || null; error.value = ''
  if (file.value && (!['image/png','image/jpeg'].includes(file.value.type) || file.value.size > 5*1024*1024)) { error.value = 'Choose a JPG or PNG image up to 5 MB.'; file.value = null; event.target.value = '' }
}
async function save(remove = false) {
  if (busy.value || !remove && !file.value) return
  if (remove) try { await ElMessageBox.confirm('Remove this product photo?','Confirm photo removal',{type:'warning'}) } catch { return }
  if (disposed) return
  busy.value = true; emit('busy',true); error.value = ''
  try {
    if (remove) await api.removePhoto(props.product.id); else await api.photo(props.product.id,file.value)
    if (disposed) return
    photoVersion.value = Date.now(); file.value = null
    if (picker.value) picker.value.value = ''
    emit('updated')
  } catch (failure) { if (!disposed) error.value = failure.message === 'LOGIN_REQUIRED' ? 'Please sign in to LEE T again.' : 'The photo result could not be confirmed. Reopen the product to verify it before retrying.' }
  finally { busy.value = false; if (!disposed) emit('busy',false) }
}
onUnmounted(() => { disposed = true; file.value = null })
</script>

<template>
  <div class="product-assets">
    <div class="product-photo-panel"><h3>Product photo</h3><img v-if="product.hasPhoto" :src="'/api/products/'+product.id+'/photo?version='+photoVersion" :alt="'Photo of '+product.name" class="product-image"><div v-else class="empty-photo">No photo</div><input ref="picker" type="file" accept="image/jpeg,image/png" aria-label="Choose product photo" :disabled="busy" @change="choose"><div class="asset-actions"><el-button :disabled="busy || !file" @click="save(false)">Upload photo</el-button><el-button v-if="product.hasPhoto" :disabled="busy" @click="save(true)">Remove photo</el-button></div><el-alert v-if="error" :title="error" type="error" :closable="false" /></div>
    <div class="product-qr-panel"><h3>Product QR</h3><img :src="'/api/products/'+product.id+'/qr'" :alt="'QR code for '+product.productCode" class="product-qr"><p>{{ product.productCode }}</p><div class="asset-actions"><a :href="'/api/products/'+product.id+'/qr/download'" download>Download QR</a><a :href="'/api/products/'+product.id+'/qr/print'" target="_blank" rel="noopener">Print QR</a></div></div>
  </div>
</template>

<style scoped>
.product-assets { display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:20px 0; }.product-photo-panel,.product-qr-panel { border:1px solid #e6ebf3;background:#f8faff;border-radius:10px;padding:18px;min-width:0; }.product-assets h3 { margin:0 0 14px;font-size:13px;color:#52637c; }.product-image,.empty-photo,.product-qr { width:160px;height:160px;max-width:100%;object-fit:contain;display:block;margin:0 auto 16px;background:#fff; }.empty-photo { display:grid;place-items:center;color:#99a4b5;font-size:12px; }.product-photo-panel>input { max-width:100%;font-size:11px;margin-bottom:14px; }.asset-actions { display:flex;align-items:center;flex-wrap:wrap;gap:12px; }.asset-actions .el-button { margin:0; }.asset-actions a { color:#245de9;font-size:12px;text-decoration:none; }.product-qr-panel p { text-align:center;color:#74829a;font-size:12px; }.product-qr-panel .asset-actions { justify-content:center; }
@media(max-width:720px) { .product-assets { grid-template-columns:1fr; } }
</style>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { createCleanupClient } from './cleanup-api.mjs'
import { createCleanupController } from './cleanup-controller.mjs'
const props=defineProps({productId:{type:String,required:true},restoreMarker:{default:null},selected:{type:Array,default:()=>[]},disabled:Boolean})
const emit=defineEmits(['updated','locked','busy'])
const cutoff=ref(''),state=ref({ready:false,busy:false,pending:null,error:'',notice:''})
let storage
try{storage=globalThis.sessionStorage}catch{/* The controller reports storage failure before a write. */}
const controller=createCleanupController({api:createCleanupClient(),storage,
  confirm:(text,title)=>ElMessageBox.confirm(text,title,{type:'warning',confirmButtonText:'Confirm',cancelButtonText:'Cancel'}),
  changed:value=>{state.value=value;emit('locked',!value.ready||value.busy||!!value.pending);emit('busy',value.busy)},
  updated:result=>emit('updated',result),
})
onMounted(()=>controller.initialize(props.productId,props.restoreMarker))
onUnmounted(()=>controller.dispose())
</script>
<template>
  <section class="cleanup-panel" aria-label="History cleanup">
    <h3>History cleanup</h3>
    <p>Only records older than 168 hours can be deleted. Each batch contains up to 5,000 records. A verified backup is created first; stock quantities stay unchanged.</p>
    <el-alert v-if="state.error" :title="state.error" type="error" :closable="false" />
    <el-alert v-if="state.notice" :title="state.notice" type="success" :closable="false" />
    <template v-if="state.pending">
      <el-alert title="A cleanup request is awaiting confirmation. Verify its result before starting another cleanup." type="warning" :closable="false" />
      <p v-if="state.pending.productId!==productId">This request belongs to another product. You can verify it here; open that product’s history to retry.</p>
      <div class="cleanup-actions">
        <el-button :disabled="state.busy" @click="controller.verify()">Verify cleanup result</el-button>
        <el-button :disabled="state.busy || state.obsolete || state.pending.productId!==productId" @click="controller.retry()">Retry same cleanup</el-button>
        <el-button v-if="state.obsolete && state.missing" type="danger" :disabled="state.busy" @click="controller.discardObsolete()">Discard obsolete cleanup</el-button>
      </div>
    </template>
    <div v-else class="cleanup-actions">
      <el-button type="danger" plain :disabled="disabled || !state.ready || state.busy || !selected.length" @click="controller.start({ids:[...selected]})">Delete selected records ({{ selected.length }})</el-button>
      <el-date-picker v-model="cutoff" aria-label="Cleanup through date" type="date" value-format="YYYY-MM-DD" placeholder="Through date (Malaysia)" :disabled="disabled || !state.ready || state.busy" />
      <el-button type="danger" plain :disabled="disabled || !state.ready || state.busy || !cutoff" @click="controller.start({cutoff:cutoff+'T23:59:59.999+08:00'})">Clean eligible records through date</el-button>
    </div>
  </section>
</template>
<style scoped>
.cleanup-panel { margin:18px 0;padding:16px 18px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px; }
h3 { margin:0 0 8px;color:#334155;font-size:15px; }
p { color:#64748b;line-height:1.6;font-size:13px; }
.cleanup-actions { display:flex;flex-wrap:wrap;gap:10px;margin-top:12px; }
.cleanup-actions .el-button { margin-left:0; }
.el-alert { margin:10px 0; }
</style>

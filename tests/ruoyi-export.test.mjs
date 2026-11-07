import test from 'node:test';
import assert from 'node:assert/strict';
import { exportInput } from '../integrations/ruoyi-vue3/src/views/leet/export-api.mjs';

test('RuoYi export filters preserve selected report and inclusive warehouse dates without mutating the form', () => {
  const form = { format:'pdf',sections:['inventory','history','reports','costs'],fields:['productCode','name','quantity'],categoryId:'category',locationId:'location',kind:'outbound',from:'2026-11-01',to:'2026-11-07',productIds:['product'] };
  const before = structuredClone(form);
  const input = exportInput(form,{id:'report',trashed:true});
  assert.deepEqual(input,{format:'pdf',sections:form.sections,fields:form.fields,categoryId:'category',locationId:'location',kind:'outbound',from:'2026-11-01T00:00:00+08:00',to:'2026-11-07T23:59:59.999+08:00',productIds:['product'],reportIds:['report'],includeTrashed:true});
  input.sections.push('other'); input.fields.push('other'); input.productIds.push('other');
  assert.deepEqual(form,before);
  assert.throws(() => exportInput({...form,sections:[]}),/data section/);
  assert.throws(() => exportInput({...form,fields:[]}),/inventory field/);
  assert.throws(() => exportInput({...form,from:'2026-11-08'}),/start date/);
  const all = exportInput({...form,format:'xlsx',sections:['reports'],fields:[],categoryId:'',locationId:'',kind:'',from:'',to:'',productIds:[]});
  assert.deepEqual(all,{format:'xlsx',sections:['reports'],fields:[]});
});

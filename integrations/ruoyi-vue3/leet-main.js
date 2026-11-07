import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import locale from 'element-plus/es/locale/lang/en'
import './assets/styles/index.scss'
import WarehouseDashboard from './views/leet/index.vue'

createApp(WarehouseDashboard).use(ElementPlus, { locale }).mount('#app')

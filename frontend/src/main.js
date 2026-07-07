import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import './styles.css';
import App from './App.vue';

window.__SOCIAL_WORKBENCH_BUILD__ = '2026-07-07-full-separation-login';

createApp(App).use(ElementPlus).mount('#app');

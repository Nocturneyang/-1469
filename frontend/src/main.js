import { createApp } from 'vue';
import ElAlert from 'element-plus/es/components/alert/index.mjs';
import ElButton from 'element-plus/es/components/button/index.mjs';
import ElCheckbox from 'element-plus/es/components/checkbox/index.mjs';
import { ElCheckboxGroup } from 'element-plus/es/components/checkbox/index.mjs';
import ElCollapse from 'element-plus/es/components/collapse/index.mjs';
import { ElCollapseItem } from 'element-plus/es/components/collapse/index.mjs';
import ElDialog from 'element-plus/es/components/dialog/index.mjs';
import ElDivider from 'element-plus/es/components/divider/index.mjs';
import ElForm from 'element-plus/es/components/form/index.mjs';
import { ElFormItem } from 'element-plus/es/components/form/index.mjs';
import ElIcon from 'element-plus/es/components/icon/index.mjs';
import ElInput from 'element-plus/es/components/input/index.mjs';
import { ElOption, ElOptionGroup } from 'element-plus/es/components/select/index.mjs';
import ElPopover from 'element-plus/es/components/popover/index.mjs';
import ElSegmented from 'element-plus/es/components/segmented/index.mjs';
import ElSelect from 'element-plus/es/components/select/index.mjs';
import { ElTabPane } from 'element-plus/es/components/tabs/index.mjs';
import ElTabs from 'element-plus/es/components/tabs/index.mjs';
import ElTag from 'element-plus/es/components/tag/index.mjs';
import 'element-plus/dist/index.css';
import './styles.css';
import App from './App.vue';

window.__SOCIAL_WORKBENCH_BUILD__ = '2026-07-13-stitch-engineered-workbench';

const app = createApp(App);
[
  ElAlert,
  ElButton,
  ElCheckbox,
  ElCheckboxGroup,
  ElCollapse,
  ElCollapseItem,
  ElDialog,
  ElDivider,
  ElForm,
  ElFormItem,
  ElIcon,
  ElInput,
  ElOption,
  ElOptionGroup,
  ElPopover,
  ElSegmented,
  ElSelect,
  ElTabPane,
  ElTabs,
  ElTag,
].forEach((component) => app.use(component));
app.mount('#app');

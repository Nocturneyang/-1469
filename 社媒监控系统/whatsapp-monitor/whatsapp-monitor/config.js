module.exports = {
  // 监控的群聊名称列表（必须准确匹配 WhatsApp 群聊名字），留空则监控所有群
  // 例如：targetGroups: ['公司核心运维群', '销售战报群']
  targetGroups: [], 
  
  // 关键人白名单（微信/Whatsapp 的备注名或者真实电话均可，部分匹配即生效）
  // 这里写你要重点盯防的老板或关键客户名字
  keyPersons: ['张总', '老板', '+86 138'],

  // 告警优先级判定规则（用于 AI 判定）
  urgencyRule: '"高"(故障/客诉/死线)、"中"(业务沟通)、"低"(闲聊/问候)',
  
  // 是否只推送重要信息（建议 true，可以大大降低噪音）
  pushOnlyImportant: true,
  
  // 消息防抖：如果在同一个群连续多条消息时间间隔在此秒数内，考虑合并（此处做简单预留配置）
  debounceTimeSec: 30,

  // 是否监控自己账号发出的消息（默认 false：只监控他人消息）
  monitorOwnMessages: false,

  // ── 对话窗口模式（聚合一段对话后再统一分析推送）──
  windowMode: false,
  windowSec: 60,
  windowMaxSec: 300,

  // ── 每群独立监控模式（覆盖全局设置）──
  // 格式：{ "群名": { mode: "single"|"window", debounceTimeSec?, windowSec?, windowMaxSec? } }
  groupConfigs: {}
};



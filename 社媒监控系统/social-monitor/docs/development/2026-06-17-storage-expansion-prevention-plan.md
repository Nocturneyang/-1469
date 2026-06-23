# 存储防范与扩容设计(不改代码)

- **日期**: 2026-06-17
- **作者**: Claude Code 会话整理
- **状态**: 待用户决策(PVC 容量、保留期、OSS 迁移、告警通道)
- **关联现象**:
  - 前端报 `database disk image is malformed`
  - 知识资产板块加载极慢
  - 日志显示 `Unknown system error -122 (EDQUOT)`、`disk I/O error`
  - Pod `restart_count: 8`,服务名 `social-monitor`,命名空间 `g1469`
- **关联文档**: `2026-06-18-storage-quota-sqlite-degradation.md`

---

## 0. 先把账算清楚

| 指标 | 数值 | 备注 |
|---|---|---|
| PVC 配额 | **10 GiB** | `.deployhub/k8s/app.yaml` 中 `storage: 10Gi` |
| 当前实际用量 | **12.4 GiB** | `/readyz` 报 `usedMb: 12735` |
| 配额超出 | **+2.4 GiB(+24%)** | 已经突破配额硬限制 |
| 代码水位线 | 512 MiB 或 5% | 触发存储退化的阈值 |
| 触发的现象 | `errno -122 (EDQUOT)` + WAL 半截 + DB malformed | 已观测 |

**核心矛盾:配额是 10 GiB,实际写入 12.4 GiB。PVC 已被"写穿"。**

为什么还能写到 12.4 GiB?多半是 NAS 底层暂时容许超配,Pod 重启或快照对齐时配额层强制收紧 → EDQUOT 集中爆发。这种"超额但还在跑"的状态比纯写满更危险:**任何一次 Pod 重启都可能让超出的部分变成不可见数据丢失**。

---

## 1. 防范分层(优先级从高到低)

### Layer 1:立刻止血(0–30 分钟,不改代码)

**目标**:让磁盘从超配回到 < 80% 水位,稳住 SQLite,前端先恢复。

按"删起来零风险 / 单位释放空间最大"排序:

| 顺序 | 对象 | 预计释放 | 操作位置 | 风险 |
|---|---|---|---|---|
| ① | **WAL 文件** `db/*.sqlite-wal` | 30 MB ~ 数 GB | Pod 内 | **零**(checkpoint 后 SQLite 自重建) |
| ② | **本地媒体临时文件** `media/.tmp`、`media/*.part` | 通常 100 MB ~ 1 GB | Pod 内 | 零(下载残留) |
| ③ | **PM2 日志** `~/.pm2/logs/*.log` | 几百 MB ~ 几 GB | Pod 内 | 零 |
| ④ | **WhatsApp Puppeteer Cache** `whatsapp-session-*/Default/Cache/`、`Code Cache/`、`GPUCache/`、`Service Worker/CacheStorage/` | 单账号 200–800 MB | Pod 内 | **零**(仅缓存,不是凭证) |
| ⑤ | **历史备份** `backups/` 中 14 天以前 | 看实际 | Pod 内 | 低(本地副本,云端镜像还在) |
| ⑥ | **过期媒体** `media/` 中超过保留期的图片/视频 | 视采集量 | `npm run media:prune` | 中(删的是已入库消息引用的文件,前端打不开历史媒体预览) |

**重要:不要碰** `whatsapp-session-*/Default/` 下的 `Local Storage/`、`IndexedDB/`、`Cookies`、`Login Data` — 这些是 WA 登录凭证,删了要重新扫码。

### Layer 2:扩容(配置变更,不改业务代码)

**目标**:把 10 GiB → 30 GiB,留足 12 个月增长缓冲。

**选型计算(基于现有数据反推):**

| 数据类 | 当前估计 | 月增 | 6 个月线 | 12 个月线 |
|---|---|---|---|---|
| `database.sqlite` | ~ 100 MB | + 30 MB | 280 MB | 460 MB |
| `analytics.sqlite` | ~ 90 MB | + 20 MB | 210 MB | 330 MB |
| `media/` | 估计 8–10 GB | + 2–3 GB | 22–25 GB | 35–45 GB |
| `whatsapp-session-*` | ~ 1–2 GB | 缓慢 | 2 GB | 3 GB |
| `backups/` | ~ 数百 MB | + 数百 MB | 2 GB | 4 GB |
| WAL + 临时 | < 1 GB | 持平 | 1 GB | 1 GB |
| **合计预测** | **~12 GB** | | **~28 GB** | **~45 GB** |

| 方案 | 容量 | 6 个月 | 12 个月 | 评价 |
|---|---|---|---|---|
| 维持 10 GiB | 10 | 已爆 | 已爆 | 不可行 |
| 扩到 **20 GiB** | 20 | 紧张 | 已爆 | 拖一次扩容,不推荐 |
| 扩到 **30 Gi**(B推荐起步) | 30 | 安全 | 紧张 | **要配套保留期清理** |
| 扩到 **50 GiB** | 50 | 安全 | 安全 | 媒体保留长(>180 天)选此 |
| 扩到 **100 GiB** | 100 | 安全 | 安全 | 仅在打算长期归档全量媒体时 |

**建议**:30 GiB 起步,同时把媒体保留期限制到 90 天(见 Layer 3)。如果业务上希望保留 180 天以上媒体,直接 50 GiB。

⚠️ **扩容前提**(必须确认):
- 当前 `storageClass` 是否支持**在线扩容**(`allowVolumeExpansion: true`)?Rainbond 默认存储类一般支持,但仍要先看 `kubectl get sc <name> -o yaml | grep allowVolumeExpansion`。
- 不支持的话需要新建大盘 → `kubectl cp` 迁移 → 切换 PVC,**会有停机**。

### Layer 3:容量治理 SOP(运维制度,不改代码)

防止扩容后再次写穿。

#### 3.1 设定明确水位线

| 水位 | 阈值 | 动作 |
|---|---|---|
| 绿 | < 60% | 正常 |
| 黄 | 60–75% | 周报关注,跑一次 `media:report` |
| 橙 | 75–85% | **必跑** `media:prune` + 备份清理 |
| 红 | > 85% | 立刻扩容 + 紧急清理 |
| 致命 | > 95% | 停 analyzers,只留 ui-server + workers,保数据完整 |

#### 3.2 制度化的定时任务(平台层,非业务代码)

在 Rainbond / K8s 里**配置 CronJob**(不改 social-monitor 代码),做这几件事:

| 周期 | 任务 | 命令(进 Pod 跑) |
|---|---|---|
| 每天 03:00 | 媒体保留报告 + 自动清理超期 | `cd /app && npm run media:prune` |
| 每天 03:30 | 备份后清理 14 天前备份 | `cd /app && npm run db:backup && npm run db:backup:prune -- --prune --execute --retention-days 14` |
| 每周日 04:00 | WAL checkpoint + 容量自检 | `sqlite3 /data/db/database.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"`(analytics 同理) |
| 每小时 | `df -h /data` 上报钉钉 | shell 监控,见 3.4 |

#### 3.3 媒体保留策略(只用现有 `media-retention.js` 配置,不改代码)

按 CLAUDE.md 的命令,媒体保留是现成的:`npm run media:report` / `npm run media:prune`。需要做的是**用环境变量配置保留期**(`.env` 加几行,部署变更不算改业务代码)。

| 媒体类型 | 建议保留 | 理由 |
|---|---|---|
| 图片 | 90 天 | 业务回溯主体在 30–60 天内 |
| 视频 | 30 天 | 单位体积大,价值密度低,过期可删 |
| 语音 | 60 天 | AI 转写后原文件价值降低 |
| 文档/PDF | 180 天 | 体积小,数量少,价值高 |
| 已被知识资产引用的媒体 | 永久 | 通过 `media-retention.js` 的引用检测保护 |

具体 ENV 变量名要看 `media-retention.js` 实现,**部署前需先确认,以免给错变量名**。

#### 3.4 容量告警(零代码改动方案)

不需要改 social-monitor。两条路:

**方案 A:Rainbond 平台自带的 PVC 监控告警**
- 在 Rainbond Web UI → 应用监控 → 配置 PVC 使用率告警 → 阈值 75% / 85% → 钉钉机器人 webhook。
- 优势:不动业务,平台层报警最及时。

**方案 B:用现有的 `/readyz` + 平台外部 ping**
- `/readyz` 已经在返回 `usedMb / freeMb / totalMb`。
- 在 Uptime Kuma / 阿里云监控里加一个 HTTP probe,正则匹配 `usedMb` 数值,超 75% → 钉钉。
- 优势:用项目自带的指标,不依赖平台。

**推荐 A + B 同时上**(A 是底层兜底,B 是业务视角)。

---

## 2. 推荐执行顺序(剧本)

按"风险递增"和"价值递减"排序,做完一步再做下一步:

```
[T+0]   读完本设计 → 确认扩容到 30 GiB
[T+5]   登 Pod, df -h + du -sh /data/* 出 top10
[T+10]  Layer 1 ① ② ③ ④ ⑤ 清理(零风险),释放第一波空间
        - 删 WAL: 用 sqlite3 wal_checkpoint(TRUNCATE), 不要直接 rm
        - 删 PM2 日志: pm2 flush
        - 删 Puppeteer Cache: rm -rf whatsapp-session-*/Default/{Cache,Code\ Cache,GPUCache}
[T+15]  确认 df -h 已掉到 <90%
[T+20]  Rainbond 控制台 PVC 扩容到 30 GiB(在线扩容,Pod 不重启)
[T+25]  等 PVC 状态 Bound + Resized
[T+30]  此时仍不要重启 Pod(怕触发 WAL 恢复路径)
        在 Pod 内跑 PRAGMA integrity_check 看库损坏程度
[T+35]  按损坏程度选修复路径(下一轮设计)
[T+45]  跑 npm run db:health 验证
[T+50]  按 Layer 3 配置 CronJob + 监控告警
[T+60]  事后:Layer 2 加代码侧错误处理(任务 #3),防止前端再看到 raw "malformed"
```

⚠️ **几个不要**:
- **不要** 在磁盘还满的状态下重启 Pod — 会再次触发 WAL 恢复失败,把损坏面扩大。
- **不要** 在没确认 storageClass 可在线扩容前点"扩容"按钮 — 部分平台会强制重建 PVC = 丢数据。
- **不要** 直接 `rm db/*.sqlite-wal` — 会丢 WAL 中未落盘的事务,可能丢最近几分钟的消息。用 `wal_checkpoint(TRUNCATE)` 走 SQLite 自己的路。

---

## 3. 长期最大化存储利用率的设计(后续可选)

这一层是把"够用"做成"好用",**仍然不改业务代码**(除 3.1 涉及业务改动):

### 3.1 把媒体迁出 PVC,放对象存储(OSS/S3)

PVC 适合**小、热、随机读写**(SQLite),不适合**大、冷、顺序读取**(图片/视频)。

| 路径 | 当前 | 推荐 |
|---|---|---|
| `db/*.sqlite` | PVC ✓ | PVC ✓(保留) |
| `media/*` | PVC ✗(占 80%+ 空间) | **OSS,Pod 内挂 ossfs 或纯 URL 引用** |
| `whatsapp-session-*/` | PVC ✓ | PVC ✓(必须本地) |

迁移后 PVC 只需 5–10 GiB 就够,且媒体成本骤降(OSS 标准存储约 ¥0.12/GB/月,远低于 SSD PVC)。

**需要业务侧动一点代码**(写 OSS Key 而非本地路径),不在"零改动"范围,但回报最大。可以作为下一阶段任务。

### 3.2 SQLite 双库分盘

如果将来分析库膨胀,可让 `database.sqlite` 和 `analytics.sqlite` 挂不同 PVC,**采集库挂高 IOPS,分析库挂便宜大盘**。当前规模不需要,记一笔。

### 3.3 备份外置

`backups/` 不应该和热数据抢同一块 PVC。建议:
- 本地保留最近 3 天 → 应急回滚用
- 7 天以上自动上传 OSS / Codeup 仓库附件 → 长期归档
- 90 天以上滚动删除

---

## 4. 待用户决策

在画出最终的"操作清单"之前,需要拍板:

1. **PVC 目标容量**:30 GiB 还是 50 GiB?(影响成本和保留期)
2. **媒体保留期**:90 天够用,还是要 180 天 / 永久?(影响是否必须 50 GiB)
3. **OSS 迁移**:这次只做扩容+清理,OSS 留到下一轮?还是这次一并规划?
4. **告警通道**:用 Rainbond 平台原生告警,还是用现有 `DINGTALK_ALERT` Webhook?

---

## 5. 下一步行动项(执行前可补)

- **A. 阅读 `lib/media-retention.js`** — 确认它支持哪些 ENV 变量(保留天数、按类型保留),给出具体的 `.env` 改动清单。
- **B. 阅读 `.deployhub/k8s/app.yaml`** — 检查 PVC 是否能在线扩容,给出具体改动行号 + Rainbond 操作步骤。
- **C. 进 Pod 实测** `df -h` 和 `du -sh /data/* | sort -hr | head -15`,把"第一波清理"精确到目录级释放量。

---

## 附:本次诊断的原始证据链

- `mcp__deploy-hub__logs(social-monitor, g1469, 300)` 输出节选:
  - 高频:`[Collector API] media failed: Unknown system error -122: Unknown system error -122, close`
  - 中频:`[knowledge-extractor] tick 出错: disk I/O error`、`[supplier-analyzer] tick 出错: disk I/O error`、`[content-review-extractor] tick 出错: disk I/O error`、`[knowledge-asset] tick failed: disk I/O error`
  - 低频但关键:`[issue-lifecycle-tracker] tick 出错: database disk image is malformed`
- Pod 状态:`Running`,`ready: true`,`restart_count: 8`
- PVC 当前配置:`.deployhub/k8s/app.yaml` 和 `社媒监控系统/social-monitor/.deployhub/k8s/app.yaml` 中 `storage: 10Gi`
- `/readyz` 端点:`usedMb: 12735`(约 12.4 GiB,已超 10 GiB 配额)
- 错误根因链:磁盘/配额满 → 媒体写失败 (EDQUOT/-122) → SQLite WAL 写失败 (disk I/O error) → WAL 半截 + Pod 重启 → WAL replay 失败 → 主库被标记为 malformed → 所有 analyzers 死循环报错 + 前端报错

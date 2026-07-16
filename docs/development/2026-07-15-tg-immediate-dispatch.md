# TG 账本化即时派发迭代

日期：2026-07-15

## 背景

客服坐席发送 Telegram 消息时，不能被同账号更早的普通 pending 外发长期阻塞。WhatsApp 外发风险更高，仍应保持保守 FIFO、单账号串行和限速。

## 结论

- WA 使用账本化串行队列：门铃只唤醒 worker，worker 按 `created_at, id` FIFO 消费。
- TG 使用账本化即时派发：API 仍先写 `outbound_messages`，门铃携带 `outbound_id`，TG worker 优先 claim 该 ID。
- TG 即时派发不是 API 直连 Telegram，也不是绕过账本发送。

## 实现规则

- `outbound_messages` 仍是唯一外发事实源，负责幂等、审计、状态展示、失败恢复和重试。
- `outbox/worker-tg-{account}/{id}.json` 只是即时唤醒和指定目标，不是任务事实源。
- TG 指定 ID claim 仍必须校验 `platform`、`account`、`status='pending'` 和 `next_attempt_at`。
- TG 指定 ID 发送前仍经过 `send_circuit_breaker`、发送间隔、每分钟限制和 lease。
- 门铃 JSON 读取失败时，worker 降级为普通 DB 扫描，不能阻塞发送兜底。
- 同一账号 runtime 仍保持 `concurrency = 1`，不并发持有或调用同一个渠道 session。

## 验收

- TG 新 outbound 可以优先于同账号旧 pending 发送。
- WA 不使用指定 ID 优先发送，继续 FIFO。
- TG 账号熔断、限速或 `next_attempt_at` 未到时，指定 ID 不会被强行发送。
- 发送结果仍回写 `sent`、`failed`、`paused` 或 `dead`，前端可继续按账本状态展示。

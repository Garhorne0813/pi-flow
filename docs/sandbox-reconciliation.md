# Sandbox 孤儿对账

`npm run build && node dist/reconcile-main.js` 可独立调度；也可设置
SANDBOX_RECONCILE_ENABLED=true，让 Worker 在 idle sweep 的间隔内运行。
默认不启用，必须先在目标 Cube 集群验证 metadata 与枚举返回结构。
管理员 POST /api/v1/admin/sandbox/reconcile 只处理当前租户，无需客户端提交实例 ID。

发现规则：Cube SDK 固定版本提供 Sandbox.list（GET /sandboxes），只返回运行实例；
校验 sandboxID/sandboxId、metadata.harnessOperation 和 harnessWorkspaceVolume。
丢失 ID 的 reserved/unknown 只有唯一 operation 候选，且 Volume 与持久 Workspace
相符才可清理；已有 ID 则必须严格匹配该 ID。未登记的外部实例、重复候选、无 metadata、
Volume 不符均不能作为释放依据，需人工核查。活动/暂停容量不做孤儿删除；列表缺失不
确认不存在，暂停/创建中和未知结果始终保守占额，不按 TTL 清理。

清理先取得持久 Workspace 生命周期租约，拒绝活跃工具/文件锁与未结束 Run，然后
CAS 原容量代次；在远端 Kill 前写回已发现 ID。确认 Kill 后才释放；失败保持 unknown
和 ID，下一次可安全重试 Kill。两个对账者或新创建代次的失败者不会调用 Kill。
每次尝试记录 sandbox.reconcile.scan 与 sandbox.reconcile 审计，不保存凭证或工具输出。
报告给出 examined/reclaimed/unresolved/failed，可对 unresolved/failed 持续非零告警。

本次自动化测试验证崩溃后的持久状态重建、并发新代保护、Kill 失败/重试、重复运行、
缺失/重复身份及跨 Volume 拒绝。真实 Cube 集群的枚举一致性、metadata 保存和 Kill
语义尚未验证；不能因此关闭 #14 的真实集群验收项。生产启用前按 #18 实测。

## #14 的真实集群关闭条件

缺少 Cube 环境的验证先搁置，独立跟踪
[#35](https://github.com/Garhorne0813/pi-flow/issues/35)；#14 保持 open，Worker
自动对账仍默认关闭。`Sandbox.list` 仅包含运行实例，列表缺失不是远端不存在证据。
以下条件须有真实集群证据才能关闭 #14：

- 创建成功、保存 ID 前崩溃；重启后完成资源发现和受控处置。
- metadata、实例 ID、operation 代次及 Volume 与持久记录一致。
- Kill 成功与失败重试、并发新代创建均不误清理新实例。
- 暂停/创建中/未确认资源持续保守占额，不按超时或列表缺失自动释放。

模拟回归是已完成的阶段成果，但不替代这些关闭条件；生产启用须完成 #18 中对应门槛。

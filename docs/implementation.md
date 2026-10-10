# 实现与验收说明

本项目将附件作为设计输入。附件中“必做 PoC”的条目是目标验收要求，不能作为已经通过的证据。

## 模块与执行边界

| 源码                        | 职责                                                            |
| --------------------------- | --------------------------------------------------------------- |
| `api.ts` / `auth.ts`        | REST/SSE、输入校验、UCS OIDC JWT、请求审计                      |
| `domain.ts` / `service.ts`  | ACL、不可变版本、状态机、幂等与交互续跑                         |
| `store.ts`                  | PostgreSQL 只读快照 / 行锁写事务 / 测试内存适配器               |
| `worker.ts`                 | 调度、续租、取消、故障收敛、工具治理与子 Agent                  |
| `runtime.ts`                | Pi AgentFactory、EnterpriseResourceLoader、Session entry 持久化 |
| `adapters/sandbox.ts`       | Cube Volume / Sandbox 管理、工作区工具租约                      |
| `adapters/remote-script.ts` | 仅在 Sandbox 执行的可信文件/命令适配代码                        |
| `adapters/mcp.ts`           | 官方 Streamable HTTP MCP Client 与 Endpoint 策略                |

Pi 工具使用显式名字 `remote_read` 等，避免与内置工具重名。ResourceLoader 返回空 Extensions/Skills 本地发现结果，远程 Skill 元数据进入受控 Prompt；内容经 remote_read 读取。Worker 不调用 Pi 的本地 read/bash 工厂。

技能按 Agent `skills` 精确挂载：`SKILL_VOLUMES_JSON` 绑定每个技能版本的独立只读 Volume、Bundle 和 SKILL.md 路径，辅助资源与 SKILL.md 放在同一 Volume 根目录。Cube SDK 没有子目录挂载，因此不再挂载整包 Volume。Sandbox 持久记录技能集合摘要；工具访问切换集合时先确认旧实例 Kill 成功，再重建实例并保留 Workspace Volume。空列表不挂载技能，旧实例缺少摘要时强制重建。重复/重叠挂载目录、共享技能 Volume、Workspace 与技能 Volume 指向同一实际卷均拒绝。发布者必须保证 Volume 只包含该技能且不可变，模板 `/skills` 为空，无其他技能挂载。

MCP 发现只遍历当前 Agent 的 Server 列表；调用与审批前再次检查工具映射、Server 授权、实时撤销和 Endpoint 一致性。子 Agent 的 skills、MCP 和工具权限取父子交集。管理面目录不属于模型的可见工具集合。

会话采用 Pi 的完整 `FileEntry[]`（Header + 规范 Session Entries），包括工具结果和 compaction entry。每条完成消息、turn 结束与 Run finally 都写入数据库。无法保存的中间响应不伪装为完整恢复；Worker 租约失效时 RUNNING → FAILED，错误码 `WORKER_LOST_UNKNOWN_TOOL_OUTCOME`。

## 运行与交互状态

新请求直接进入 QUEUED，Worker 领取后 RUNNING。合法终态为 COMPLETED / FAILED / CANCELLED；需要输入时 WAITING_INPUT。审批期间旧 Run 占用 Session；回答后原 Run 记为 completed/continued，新 Run 携带交互 ID 安全继续。回答幂等，不同答案再次提交返回 409。

审批保存模型请求的工具名称和校验后的参数；批准后新 Run 先检查当前 ACL/工具能力，再执行保存的操作一次，随后将结果送入 Pi。拒绝不会执行该操作。中途 Worker 故障将新 Run 标记 FAILED，不会自动重新执行批准过的操作。

同 Session 写入互斥由事务保证。不同 Session 可并行推理；同 Workspace 的 Agent 远程工具与文件写入串行，冲突返回 WORKSPACE_BUSY；文件读取使用独立临时实例，可与 Agent 工具并行，不改变 Agent 生命周期。文件租约阻止生命周期操作/删除与文件访问重叠；独立实例只挂载 Workspace，纳入 owner/全局配额，结束后确认 Kill，未知创建/清理结果保留容量。SDK/工具错误不由 Harness 自动重试，模型可看到已确认失败的结果；未知结果必须人工处理。

取消会中断 Pi；远程工具执行中会 Kill 整个 Workspace Sandbox，并保留 Volume。Kill 失败时尝试记录 `REMOTE_CANCEL_UNCONFIRMED` / FAILED，而不是声称远端进程已停止。取消期间同 Workspace 的工具租约阻止其他工具进入。下一次访问会连接或重建实例。真实远端取消语义仍需集群验收。

## 验证证据与范围

已执行自动测试：

- 多租户资源隐藏、成员/Agent 撤销、管理员权限、严格配置校验。
- 并发幂等、同 Session 互斥、工作区同 Run 并行工具互斥。
- 审批/拒绝/问答持久状态、新 Run 续跑、审批副作用仅执行一次。
- 子 Agent 权限交集与独立 Session、工具和 Token 预算。
- Worker 故障不重放、Run 取消、SSE 终态事件与游标回放。
- 真实 Pi 0.99.2 对接本地模拟网关：只有 remote_read，规范 Session Entries 恢复后含原工具结果。
- 真实 MCP SDK 对接本地 HTTPS Streamable HTTP Server：筛选工具、认证头与实时撤销。
- Agent 技能挂载计划（Cube SDK 调用替身）、不同 Session/父子 Agent 切换技能范围、工作区保留、旧实例替换、Kill 失败拒绝访问；未授权 MCP Server 不被访问、不被发现、不可调用或申请审批。
- 真实 UCS JWT/JWKS HTTPS 验证：签名、issuer/audience/expiry/tenant。
- 真实 PostgreSQL 17：多个客户端并发序列化、事务回滚、关闭连接后持久数据读取。
- 可信远程 Python 适配代码：路径/符号链接拒绝、只读 Skills 写入路径拒绝、编辑哈希冲突、超时。

最后一项测试中的文件路径约束不等于 Cube 的只读 Volume 挂载证明；模拟生命周期不等于跨节点验证。

仍需真实服务验收：

1. 实际 Shell 身份不能修改 /skills，不能 sudo，不能访问其他 Workspace Volume。
2. Cube Kill 后挂载原 Volume，跨节点 Attach 和数据一致性；节点驱动拓扑和存储备份。
3. 取消后远端整个进程树确实终止；网络超时和 Kill 未确认情况下的运维收敛。
4. 企业 UCS claim/group 映射、中央即时撤销、模型网关错误/Token usage 格式。
5. 企业 MCP 权限与委托凭证；技能发布 Volume 的不可变性。
6. 预期容量、限流、压测、故障演练、审计/历史/事件保留策略、数据库与 Volume 的独立备份恢复。

## 数据与运维

当前 Sandbox 容量独立保存在 `harness_sandbox_leases` 关系表，旧 `harness_sandbox_capacity` JSONB 仅供迁移审核。预留和转换仍以 transaction-scoped 全局 advisory lock 串行保护索引计数与状态变更，消除的是全局 JSONB 全量写入，不是全局容量竞争。用户配额计入 Workspace owner（Tenant + subject），global 配额包含所有共享此数据库的已管理实例。reserved/unknown 持续占用，只有确认暂停或释放后退还；released 标记阻止旧实例启动登记与删除之间的竞态。远程未知结果不自动重放或按时间释放，完整孤儿对账仍需运维接入。

Worker 定期扫描空闲工作区，并通过同一 Workspace 工具租约再次检查最后访问时间与 QUEUED/RUNNING Run。暂停保留实例；释放只 Kill 实例，不删除 Volume/Session/登记快照。快照创建/列表/删除/恢复/克隆加入 Workspace ACL 和审计。恢复/克隆用 SDK 快照模板显式重建网络与挂载，检查快照的技能范围与当前注册/部署映射；克隆不复用原 Workspace Volume。快照不是外置 Volume 或 PostgreSQL 的备份。真实 Cube 暂停/恢复、快照语义与跨节点行为仍需集群验收。

迁移 001–004 按顺序运行，组合运行时 readiness 要求 schema version 4。`harness_tenants` 保留租户元数据，Session、Run/租约和 Event 已迁到独立关系表。普通跨实体事务仍持有租户级元数据锁并 diff 写入变化实体，runTx 使用共享元数据锁与目标 Run 行锁；心跳和单 Run 终态不重写整租户 JSONB。所有 API/Worker 操作从可信身份选择 Tenant，使用参数化 SQL；事务按上述锁协议保证多实例一致性；只读接口使用已提交快照，不创建缺失租户、不获取 FOR UPDATE 锁、不更新 revision，SSE 鉴权与索引事件页在同一个 SELECT 快照中读取。SSE、列表、统计、MCP 授权检查及 Worker 空闲扫描/执行上下文查询采用只读接口，业务变更、心跳、事件和每请求完成审计仍写事务，但使用不同的专用写路径。容量 get/usage 同样采用 capacityRead。这是明确的容量折中，不宣称等价于附件中的完整关系表设计。

事件序号在租户内单调递增；SSE `Last-Event-ID` / `after` 仅回放该 Run 的事件。当前保留期为无限，生产必须设置归档/删除政策；事件已经独立建表，归档实施仍待完成。SSE 暂停于 WAITING_INPUT；回答返回新 Run ID 后，前端订阅新 Run。

Volume 名为 `ws-{workspace UUID}`，创建前查询同名 Volume，允许恢复“创建后未保存引用”的情况。Sandbox 附有 Workspace Volume / Bundle 的 metadata 供外部资产对账。创建 Sandbox 后、记录 ID 前进程崩溃仍可能留下孤儿实例；已提供默认关闭的 SandboxReconciler，尚未通过真实 Cube 验收。Sandbox.list 仅列运行实例，列表缺失不能证明暂停/创建中资源不存在；#14 / #35 关闭条件包含真实崩溃恢复、身份/代次/Volume 一致与 Kill 重试不误清理新代。禁止删除仍有 Run 或工具租约的工作区；先取消并等终态，再删除。清理依次 Kill Sandbox → 删除 Volume → 删除 Workspace 元数据；Session/Run 日志保留但资源不再可访问，适用于审计归档策略定稿前。

部署服务应使用独立的数据库账号、容器非 root 身份、仅必要网络出口。生产 `TENANT_CAPABILITIES_JSON` 限定每个租户可引用的 Skill Bundle 和 MCP Endpoint，租户管理员也不能扩大这个上限。MCP URL 和模型网关 URL 只来自部署配置，后台不能填写任意 URL 或可执行代码。Endpoint 网络 allowlist、TLS CA 与凭证授权必须由基础设施提供。

## work 分支 Issue #1–#4 回归

Worker 对排序后的租户保存上次扫描游标，下个 tick 从后继租户开始；游标随 Worker 生命周期保存，新建/删除租户仍按排序寻找后继。每 tick 每租户至多领取一个 Run；同 Worker 的重叠 tick 串行，多 Worker 仍在数据库写事务中原子领取。空闲扫描不写回状态，过期租约和实际领取会在写事务里再次检查。Run 租约恢复、取消和状态迁移沿用原规则。

Sandbox 工具参数中的 manifest 注册表由 Harness 覆盖注入，模型不能选择摘要。远程代码在规范路径检查后读取 manifest 并比对实际字节的 SHA-256，所有工具执行前校验当前挂载清单；read/grep 返回内容前再次验证解析后的文件身份。grep 不吞掉完整性异常。Worker 对返回的规范路径追加验证，有 Skill 的读取缺少路径身份时拒绝。辅助文件不套用 manifest 摘要。允许读取指向 manifest 的范围内符号链接别名，但登记 manifest 本身不能是符号链接。bash 的执行前校验依赖只读不可变技能 Volume，不能保证外部发布者并发改写后的内容。

回归覆盖：只读快照不持久化变更、读回调并行；PostgreSQL revision 不变、持有写锁时读旧已提交快照；SSE 两页以上顺序回放、Last-Event-ID、空闲轮询无写事务和即时 ACL 撤销；viewer 文件 API 与 Skill Agent 并发、实例/范围/空闲计时不变、路径拒绝、配额及未知清理重试；规范/点点/符号链接路径摘要错误拒绝、grep/bash 执行前检查、辅助文件兼容；双租户持续入队轮询、重叠 tick 与真实 PostgreSQL 独立 Worker 单次领取。只读混合负载结果与限制见 [read-benchmark.md](read-benchmark.md)。

## work 分支 Issue #5–#7 回归

容量操作使用唯一 `operation` 作为持久 fencing token，激活、暂停和 released tombstone 都保留标识。reserve/claim 在同一 `capacityTx` 内比较预期 operation、实例 ID、状态与更新时间；active/pending 失去标识时拒绝，released/unknown/paused 的迟到标识不修改状态。接管先更新标识及 reserved 状态，再 Kill 旧实例；旧实例清理与新实例配额归属分别处理。临时文件实例、Agent、手动生命周期、快照恢复和 Workspace 删除均检查归属。每次 Agent 工具租约生成新标识，即使同 Run 连续调用也不会复用；心跳失败后 Kill 同样检查标识，避免迟到取消杀掉新请求复用的实例。

Run AbortSignal 贯穿 Sandbox provisioning：创建前、连接/创建完成、容量激活和回调边界重新检查。已取消信号在 listener 安装后再次检查，防止遗漏。取消时停止本地等待；迟到的实例 ID 按原 operation 对账并清理，保留 Workspace Volume。创建结果未知（无 ID）或 Kill 未确认保持 unknown/charged；不会把取消当作远端从未创建的证明。清理只能修改本代容量和仍由本代持有的 Workspace 元数据。

MCP discovery 继承 Run 信号，完整预算最多 30 秒且不超过剩余 deadline；Server 配置最多 16 项，兼容历史状态时也检查上限。connect/listTools 的 SDK options 和 transport 的 fetch 都传播 signal；本地 Promise race 保证故障实现忽略 signal 时也能退出等待。连接失败和每个 Server 结束后都直接尝试关闭 Client 与 Transport，以 250 ms 限制清理等待，避免异常关闭覆盖原始错误。成功发现后移除发现定时器与 Run listener；实际工具调用使用该次调用的 Run signal。

确定性回归编排 A 文件租约过期、B 接管并激活、A 迟到成功/未知 Kill，两种情况都保持 B 记录与配额；Agent 迟到取消同样不 Kill B 复用的实例。真实 PostgreSQL 的两个客户端竞争同一观察值，仅一方接管，旧 active/paused/released/unknown 无法覆盖新记录。取消覆盖创建前、阻塞创建、连接、激活/listener 边界、已知清理成功、Kill 未确认和无 ID 创建未知。MCP 覆盖多 Server、多页、connect/listTools 永久卡住、关闭抛错/卡住、总预算、预先取消/过期 deadline/Server 上限、Worker 释放槽位并调度下一条，以及真实本地 HTTPS 卡住 tools/list 时断开传输。原有白名单、Endpoint/grant 与撤销测试继续保留。

部署升级须同时更新 API 和所有 Worker，不混跑旧版无 fencing 的容量写入者。上述 #5–#7 为旧 work 基线的 fencing 修复；组合分支另有 001–004 结构迁移及回填，必须按容量/Run 迁移手册切流，不能继续按旧版“无结构迁移”部署。真实 Cube 集群的取消和存储挂载语义仍需验收。

## work 分支 Issue #8–#9 回归

Sandbox 控制请求的本地等待最多 30 秒，工具执行最多 130 秒；Agent provisioning/执行同时接受 Run 的 AbortSignal，因此剩余 deadline 更短时按 Run deadline 停止等待。SDK 忽略取消也不占住 Worker 槽位。清理 Kill 最多等待 1 秒；未确认、无 ID 的创建以及仍在连接的实例保留 unknown/charged，Run 失败为 `REMOTE_CANCEL_UNCONFIRMED`。连接尚未返回时不能先释放配额：迟到的连接可能恢复实例，必须等结果返回后再清理。

创建前记录 operation 与 Volume 引用，Cube Sandbox metadata 增加 `harnessOperation`。迟到 Volume 记录 `sandbox.volume.late`；Volume 名仍为 `ws-{workspace UUID}`，不会因请求取消而删除共享 Workspace 卷。迟到实例记录 `sandbox.creation.late`，仅原 generation 可以清理并释放容量；已被后继接管时，不 Kill 后继的 ID，独立孤儿 ID 登记到 `{workspace}:orphan:{operation}` 并继续计入原 Workspace owner 的配额。清理完成记录 `sandbox.creation.reconciled` / `sandbox.kill.reconciled`。这些记录供运维对账；当前另有默认关闭的跨进程 SandboxReconciler，但真实集群枚举/metadata/Kill 尚待 #14 / #35 验收；未确认资源仍保守占额，不按年龄自动释放。Worker stop/start 的收尾最多等待 5 秒，未完成时明确抛出 `WORKER_SHUTDOWN_UNSETTLED`，不能将它当作成功关闭。

所有获批 MCP 工具都按可能有外部副作用处理。调用先持久化 `tool.dispatching` 意图，实际启动 tools/call 的 fetch 后记录 `tool.dispatched`；收到 SDK 校验后的工具响应记录 `tool.confirmed`，并保留 `tool.completed` 结果。发出请求后的取消、超时、响应丢失或传输错误记录 `tool.unknown`，抛出 `MCP_OUTCOME_UNKNOWN`，强制 Run 为 FAILED，即使用户已经请求取消也不改为 CANCELLED。Worker 立即中止模型，不自动重试或重放已批准的调用。发送前取消仍可正常取消；已确认响应不会仅因同时收到取消而改为未知。

事件含 callId、runId 和可选 requestId；tools/call 的 JSON-RPC `_meta` 包含同样的关联信息，HTTP `x-harness-call-id` / `x-harness-run-id` 可供服务端日志对账。关联信息不构成服务端幂等保证，也不证明远端回滚。白名单、审批与实时撤销继续生效。

新增回归覆盖四种 Sandbox 请求永久挂起、迟到 Volume/create/connect/kill、后继复用与独立孤儿、同 Worker 超时后调度下一 Run、有界停机错误；真实本地 HTTPS MCP 在副作用完成后阻塞响应，通过正常审批与继续流程取消，确认 FAILED/未知、关联 ID 一致且调用不重放。另验证发送前取消、确认结果后取消、Run deadline 超时和没有取消的响应丢失。

## Review 后的验收分界

#11 的普通跨实体租户元数据锁和 #13 的全局 advisory lock 是扩展边界。局部合成
基准仅支持特定存储路径的对比；保留原子配额、租约 fencing 和不重放正确性，
实际压测确认瓶颈后才讨论新计数协议，不宣称消除所有竞争或达到生产 SLO。

#18 是生产验收总任务及发布阻塞项；多进程 Worker、真实 PostgreSQL、SSE 合成负载、
本地 MCP 协议和 Pi SDK 合约测试分别作为已完成阶段成果。真实 Cube/MCP/网关由
#35/#36/#37 单独跟踪，数据库恢复及代表性混合负载仍在总任务验收内。Cube 部分
先搁置，#14 不关闭且 Reconciler 默认关闭；详见 [acceptance.md](acceptance.md)。

#19 验收可执行预算控制与可审计成本估算。请求前预留、可信 usage 和服务端价格
快照不保证 tokenizer 精确、单次绝不超支或供应商账单准确；unknown 保守占额，
Sandbox 时间仅为观察区间。财务级账单对账由 #38 独立跟踪，详见
[usage-budgets.md](usage-budgets.md)。

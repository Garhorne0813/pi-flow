# 实现与验收说明

本项目将附件作为设计输入。附件中“必做 PoC”的条目是目标验收要求，不能作为已经通过的证据。

## 模块与执行边界

| 源码                        | 职责                                                            |
| --------------------------- | --------------------------------------------------------------- |
| `api.ts` / `auth.ts`        | REST/SSE、输入校验、UCS OIDC JWT、请求审计                      |
| `domain.ts` / `service.ts`  | ACL、不可变版本、状态机、幂等与交互续跑                         |
| `store.ts`                  | PostgreSQL 只读快照 / 行锁写事务 / 测试内存适配器                            |
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

Sandbox 容量保存在单独的 `harness_sandbox_capacity` JSONB 行，PostgreSQL 行锁将各租户、各 API/Worker 的容量预留串行化。用户配额计入 Workspace owner（Tenant + subject），global 配额包含所有共享此数据库的已管理实例。reserved/unknown 持续占用，只有确认暂停或释放后退还；released 标记阻止旧实例启动登记与删除之间的竞态。远程未知结果不自动重放或按时间释放，完整孤儿对账仍需运维接入。

Worker 定期扫描空闲工作区，并通过同一 Workspace 工具租约再次检查最后访问时间与 QUEUED/RUNNING Run。暂停保留实例；释放只 Kill 实例，不删除 Volume/Session/登记快照。快照创建/列表/删除/恢复/克隆加入 Workspace ACL 和审计。恢复/克隆用 SDK 快照模板显式重建网络与挂载，检查快照的技能范围与当前注册/部署映射；克隆不复用原 Workspace Volume。快照不是外置 Volume 或 PostgreSQL 的备份。真实 Cube 暂停/恢复、快照语义与跨节点行为仍需集群验收。

`migrations/001_initial.sql` 可重复执行。首版有一张 `harness_tenants` 表，整个租户状态作为事务聚合。所有 API/Worker 操作从可信身份选择 Tenant，使用参数化 SQL；写事务使用租户行锁保证多实例一致性；只读接口执行单条普通 SELECT，返回分离快照，不创建缺失租户、不获取 FOR UPDATE 锁、不更新 revision。SSE、列表、统计、MCP 授权检查及 Worker 空闲扫描/执行上下文查询采用只读接口，业务变更、心跳、事件和每请求完成审计仍写事务。容量 get/usage 同样采用 capacityRead。这是明确的容量折中，不宣称等价于附件中的完整关系表设计。

事件序号在租户内单调递增；SSE `Last-Event-ID` / `after` 仅回放该 Run 的事件。当前保留期为无限，生产必须设置归档/删除政策并拆分大日志表。SSE 暂停于 WAITING_INPUT；回答返回新 Run ID 后，前端订阅新 Run。

Volume 名为 `ws-{workspace UUID}`，创建前查询同名 Volume，允许恢复“创建后未保存引用”的情况。Sandbox 附有 Workspace Volume / Bundle 的 metadata 供外部资产对账。创建 Sandbox 后、记录 ID 前进程崩溃仍可能留下孤儿实例；首版无完整资产扫描任务，需按 metadata 与数据库引用对账。禁止删除仍有 Run 或工具租约的工作区；先取消并等终态，再删除。清理依次 Kill Sandbox → 删除 Volume → 删除 Workspace 元数据；Session/Run 日志保留但资源不再可访问，适用于审计归档策略定稿前。

部署服务应使用独立的数据库账号、容器非 root 身份、仅必要网络出口。生产 `TENANT_CAPABILITIES_JSON` 限定每个租户可引用的 Skill Bundle 和 MCP Endpoint，租户管理员也不能扩大这个上限。MCP URL 和模型网关 URL 只来自部署配置，后台不能填写任意 URL 或可执行代码。Endpoint 网络 allowlist、TLS CA 与凭证授权必须由基础设施提供。

## work 分支 Issue #1–#4 回归

Worker 对排序后的租户保存上次扫描游标，下个 tick 从后继租户开始；游标随 Worker 生命周期保存，新建/删除租户仍按排序寻找后继。每 tick 每租户至多领取一个 Run；同 Worker 的重叠 tick 串行，多 Worker 仍在数据库写事务中原子领取。空闲扫描不写回状态，过期租约和实际领取会在写事务里再次检查。Run 租约恢复、取消和状态迁移沿用原规则。

Sandbox 工具参数中的 manifest 注册表由 Harness 覆盖注入，模型不能选择摘要。远程代码在规范路径检查后读取 manifest 并比对实际字节的 SHA-256，所有工具执行前校验当前挂载清单；read/grep 返回内容前再次验证解析后的文件身份。grep 不吞掉完整性异常。Worker 对返回的规范路径追加验证，有 Skill 的读取缺少路径身份时拒绝。辅助文件不套用 manifest 摘要。允许读取指向 manifest 的范围内符号链接别名，但登记 manifest 本身不能是符号链接。bash 的执行前校验依赖只读不可变技能 Volume，不能保证外部发布者并发改写后的内容。

回归覆盖：只读快照不持久化变更、读回调并行；PostgreSQL revision 不变、持有写锁时读旧已提交快照；SSE 两页以上顺序回放、Last-Event-ID、空闲轮询无写事务和即时 ACL 撤销；viewer 文件 API 与 Skill Agent 并发、实例/范围/空闲计时不变、路径拒绝、配额及未知清理重试；规范/点点/符号链接路径摘要错误拒绝、grep/bash 执行前检查、辅助文件兼容；双租户持续入队轮询、重叠 tick 与真实 PostgreSQL 独立 Worker 单次领取。只读混合负载结果与限制见 [read-benchmark.md](read-benchmark.md)。

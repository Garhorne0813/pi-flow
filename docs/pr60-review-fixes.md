# PR #60 评审修复

1. **Compose 初始化**：挂载全部 001–011 迁移。`npm run smoke:compose` 用独立项目、随机端口和全新数据库卷启动 PostgreSQL/API，检查两个 schema 版本并通过 HTTP 完成一个个人 Run；结束后只删除该项目的资源。CI 执行完整构建及启动。可通过 `COMPOSE_SMOKE_IMAGE` 使用已经构建的镜像。
2. **模型执行快照**：管理模型目录时生成只追加的 `modelGatewayVersions` 和 `modelSecretVersions`，密钥版本只保存加密密文。Run 保存私有 `modelGatewayRef`，审批续跑继承该引用；Worker 按引用解析 URL 和密钥版本，不再用当前目录重新批准旧 Run。`null` 固定使用部署环境网关。启动时为既有目录补齐版本；没有该字段的升级前 Run 保留兼容解析，但无法恢复升级前已丢失的历史网关/密钥。版本随平台配置持久化，当前不自动清理；更换 `CONFIG_SECRET_KEY` 前须重新封装仍被引用的密文。
3. **工具撤销边界**：平台策略在事务取得锁后读取，沙箱租约授权、准备结束和实际 Provider 调用前均重新检查 Run/工具策略。内存工具派生写入也使用原工具授权；MCP 在 HTTP dispatch 前复核。已发送的远程命令不能原子撤回，也不保证取消会回滚已产生的效果。
4. **定时任务更新**：修改 Agent、cwd 或 Session 模式会清除复用 Session 绑定，下次触发创建正确的 Session。更新及触发都检查 Agent 可访问性和用户 Token 限制。旧 Run 不随任务编辑改变；Session 缺失、删除或配置不匹配时也不会复用。
5. **PostgreSQL 热路径**：Worker 使用目标 Run 的认领事务；用户元数据锁和运行中 Run 的部分索引保证跨 Worker 串行执行，不再加载该用户全部 Run、Session transcript 或 Event。调度按到期任务/已结束 Run 的待结算 Fire 读取，每轮最多处理 64 个任务，单任务每次最多结算 64 个 Fire。009 迁移将重复的调度元数据从用户状态文档移到专用表，并补齐索引。事务内平台配置读取复用当前数据库连接，避免连接池满时申请第二个连接造成死锁。

## 验证

- 内存及真实 PostgreSQL 覆盖模型目录替换、同名密钥轮换后执行排队 Run、审批续跑与新根任务。
- 在 Sandbox 创建/连接期间禁用 write、edit、bash 和内存写入，确认没有发生远程变更。
- 12 个并发认领请求及两个客户端的定时任务触发，确认同一用户仅有一个运行中 Run、同一触发只产生一个 Fire。
- 009 迁移覆盖旧元数据回填和重复执行；Agent/cwd 编辑后检查新 Session 和 Run 配置。
- `TEST_DATABASE_URL=postgres://... node --import tsx scripts/acceptance/personal-history.ts` 对比无历史与 5,000 Run、50,000 个 1 KiB Event、5,000 Fire 的场景，记录真实返回行数/字节和认领、调度的 P95。测试禁止这些热路径读取历史事件，并验证传输量保持有界；延迟数据用于比较，不作为生产 SLA。

兼容性的全量事务仍供其他管理操作使用；审计/工作区元数据仍在 JSONB 中，服务端提取字段可能有 TOAST 成本。该轮验证针对认领和周期调度，后续文件 API 验证见下文；其他管理 API 仍可能加载完整历史。部署 009 前须停止旧 API/Worker，再执行迁移。

评审修复提交 `add7303` 的本地完整强制验收为 **295 通过、0 失败、0 跳过**；收尾的元数据定向读等 61 项回归通过。类型检查、构建、Demo 冒烟、SDK 校验与 `npm audit --audit-level=high` 通过。Compose 使用本次构建的镜像和新卷执行全部 9 个迁移，两个 schema 为 v6，HTTP Run 为 COMPLETED。

一次本地全量测试中的基准如下（P95 为毫秒，包含数据库与应用往返开销）：

| 历史 Run / Event / Fire | 认领行数 / 字节 | 调度行数 / 字节 | 认领 P95 | 调度 P95 |
| --- | --- | --- | --- | --- |
| 0 / 0 / 0 | 7 / 3516 | 8 / 3447 | 10.54 | 24.19 |
| 5000 / 50000 / 5000 | 7 / 3519 | 8 / 3450 | 19.94 | 17.16 |

## Token 刷新与 009 readiness 补充

- 审批/提问响应将已认证请求的 Bearer 传入 Service，根据原 Run 的 Token 能力封装新密文，绑定原 userId/taskId。只刷新同一调用者的未终态任务链，保留全部配置、模型和任务标识快照；缺少 Token 或校验失败时事务回滚，不消费交互。幂等重试返回已有续跑，不改写已接受的凭证。审计仅记录刷新动作和 taskId，不写 Token 或密文。
- 009 在归一化数据和索引完成后将个人 schema 推进到 v7；`ready()` 校验调度表和三个索引的表归属、`indisvalid`、`indisready`。漏执行、未提交或回滚 009，以及迁移后缺表/索引都不能通过 readiness。共享 schema 保持 v6，当轮 Compose 期望 `6:7`，新增 010 后为 `6:8`。升级前须停止旧 API/Worker 并重新执行全部迁移，当前迁移器会幂等重放 009。
- 内存/API 和真实 PostgreSQL 回归验证：旧 Token 过期、新认证批准、实际 bash 使用新 Token，原配置仍生效；以及 v6 拒绝就绪、009 回滚/提交、旧调度数据回填、逐个删除索引后拒绝就绪。

## 管理员白名单、账号撤权、调度失败与文件 API 补充

- OIDC 管理员用户/角色白名单统一 trim 并移除空项；角色必须是字符串，不将任意 JWT 值转成字符串匹配。签名 JWT 回归覆盖未配置白名单、空角色数组、空字符串角色、普通角色和带空白的有效配置；保留显式 harness-admin 角色语义。
- 已连接 SSE 每秒复查账号状态，同一连接最多一个检查在途，不依赖新事件到达、分页或 drain。禁用后返回 ACCESS_REVOKED 并结束；背压时销毁连接以释放等待，错误帧可能无法送达。身份库不可用也会关闭连接；JWT 到期计时独立保留。真实 PostgreSQL、两个客户端和真实 HTTP 测试覆盖空闲连接、停止读取的背压连接以及禁用后新请求拒绝。
- Fire 前置失败和已提交 Run 的终态统一结算，失败各累计一次；达到 maxConsecutiveFailures 后自动禁用 Schedule。成功完成清零；SESSION_BUSY 跳过既不累计也不清零。重复 Fire 或多次 tick 不重复计数；回归覆盖 Run 创建 Fault、禁用 Agent、成功恢复和 cron 自动停用。
- ensureWorkspace 先只读工作区元数据；缺失才在原子事务中初始化。个人文件 GET/PUT/DELETE 的沙箱租约、卷创建及清理也使用工作区事务，锁定同一用户元数据行并读取 RUNNING Run，保留 Worker 跨客户端互斥；不加载历史 Run、Session 或 Event。工作区写入定向更新 JSONB，审计和资源记录只追加，不覆盖其他元数据。文件专用管理器复用容量初始化结果。
- 扩展既有大历史基准，实际调用 HTTP PUT、GET、DELETE，包含沙箱租约、容量与请求审计；对比 0 与 5,000 Run / 50,000 个 1 KiB Event / 5,000 Fire，断言读取行数相等、字节数保持有界且没有读取历史事件。另以跨客户端回归覆盖并发初始化、RUNNING 时文件拒绝，以及已有审计/资源/自定义元数据保留。

本次不需要新增迁移。工作区与审计仍存于 JSONB，数据库端字段提取/追加可能有 TOAST 成本；验证证明历史执行记录不会传回文件 API 应用层，不构成生产延迟承诺。

本地一次完整验收中的文件 API 基准（PUT/GET/DELETE 合计，P95 毫秒）：

| 历史 Run / Event / Fire | 返回行数 | 返回字节 | 文件三请求 P95 |
| --- | --- | --- | --- |
| 0 / 0 / 0 | 114 | 74448 | 164.88 |
| 5000 / 50000 / 5000 | 114 | 74448 | 171.93 |

本轮最终全量强制验收：**301 通过、0 失败、0 跳过**；类型检查、构建、Demo 冒烟和差异检查通过。既有 Token 到期背压回归改为持续观察背压，避免并发负载下固定 350ms 取样未进入背压造成误判；仍要求到期关闭服务器连接。

## 只读身份复核、调度入场回滚、Session 分页与 Memory 成功配额

- Registry 新增只读 verifyIdentity；SSE 和 Worker 对既有身份的复核只执行 SELECT id,enabled，不调用身份注册的 INSERT/UPSERT。缺失、禁用或 UUID 不匹配均拒绝，复核不创建用户。真实 PostgreSQL 下建立 8 条并发 SSE，等待每条多次复核后，用户行 xmin 保持不变；随后禁用账号，全部连接收到撤权错误并结束。
- Schedule 入场失败只移除本次新建 Session，并恢复 task.sessionId 的原值（原来未绑定则删除该字段）。失败 Fire 和连续失败计数仍正常提交；既有会话和已提交 Run 保留。覆盖 sessionMode=new、默认模型不可用、重复失败、首次成功后再次失败及阈值停用。
- GET /sessions 在 PostgreSQL 中按 user_id、Session.userId 和 deletedAt 筛选，以 createdAt DESC、session_id DESC 稳定排序，再执行 LIMIT/OFFSET。结果排除 entries；内存实现返回同样的摘要形状。010_personal_session_pagination.sql 增加部分索引 personal_sessions_list 并发布个人 schema v8；readiness 要求 v8 及该索引归属正确、indisvalid/indisready。Compose 挂载 001–010 并验证共享/个人版本 6:8。部署须停止旧 API/Worker，再执行全部迁移后启动。
- Memory 的 maxWritesPerRun 按成功完成主题与派生索引写入的次数计算。事务原子预留并发槽位，memoryWrites 仅在两次远程写入都返回成功后累计；失败/取消释放预留。不同 Worker 租约的遗留预留在新尝试时清除。memory.write.attempt、memory.write.failed 与成功的 memory.write 分开记录，错误仅审计固定代码。预留/结算和对应审计分别在同一事务中提交；此处仍使用兼容的完整状态事务。
- Memory 回归覆盖总量超限的十次失败、沙箱/主题/索引写入错误、取消、成功重试、达到配额后的拒绝、多个 MemoryManager 并发及真实 PostgreSQL 跨客户端退款/成功结算。远程文件变更与数据库不是分布式事务：失败可能已留下部分文件；进程在远程成功与数据库结算之间崩溃，也不能保证精确一次计数。
- Session 分页回归覆盖隔离、软删除、同时间戳分页、排除 transcript，并检查查询计划使用新增索引而无需排序。既有大历史基准增加 5,000 个带 1 KiB entries 的 Session，并实际请求 limit=1，验证返回行数/字节有界且不读取历史 Event。OFFSET 的深分页仍需遍历前面的索引项，JSONB 字段提取仍可能有数据库端 TOAST 成本。

本轮最终强制验收：**311 通过、0 失败、0 跳过**，类型检查、构建、Demo 冒烟及差异检查通过。定时任务的并发结算回归使用显式 due 时间和年度 cron，避免测试跨真实分钟边界时产生额外 Fire 干扰断言。

本地最终全量验收中的 Session 列表 limit=1 基准（P95 毫秒，不作为生产 SLA）：

| 额外历史 Session / Run / Event | 返回行数 | 返回字节 | Session 列表 P95 |
| --- | --- | --- | --- |
| 0 / 0 / 0 | 1 | 237 | 6.22 |
| 5000 / 5000 / 50000 | 1 | 237 | 7.06 |

## 数据库生命周期专项

本轮处理 HTTP 写放大、全局 Worker 候选、模型执行事务、流式事件批量、沙箱维护、SSE 通知、Run 续租、定向 GET 和 revision 配置缓存。新增 011、个人 schema v9，完整设计、验收方式及实测见 [数据库运行热路径](runtime-hotpaths.md)。

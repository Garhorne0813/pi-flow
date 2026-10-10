# 发布与回滚

应用基线来自 `work`，通过 PR 发布到 `main`，禁止强制覆盖或绕过评审。
所有后续发布 PR 必须通过 `quality / quality`：Node 24 的安装、类型检查、
真实 PostgreSQL 集成测试、完整测试、构建和 Demo smoke。
CI 显式设置 REQUIRE_POSTGRES_TESTS，缺失数据库地址将失败，不能隐式跳过。

仓库管理员在 GitHub Settings → Rules → Rulesets 为 main 启用分支规则：
Require a pull request、Require status checks（quality、vendor、postgres-fault-load）、Block force pushes、
Restrict deletions。首次 workflow 跑完后选择实际检查名称；未配置规则之前，
workflow 只报告检查结果，不能保证阻止合并。

发布前检查 git diff、配置示例、vendored 许可证，不提交 .env、日志、测试证书
或 work/ 产物。构建发布只使用 npm ci 与锁文件，不在启动时安装依赖。
记录发布 commit、CI URL、镜像 digest 和数据库迁移版本；先迁移，再统一升级
API/Worker，禁止混跑不兼容的租约版本。Demo/mock 通过不代表 Cube 生产验收。

回滚前停止领取新 Run，等待在途任务收敛，备份数据库和 Workspace Volume。
应用回滚到上一份通过检查的镜像；涉及 schema 变更时遵循该迁移的回滚手册。
对未知远端工具结果保持失败/人工对账，不自动重放。

## 生产发布验收门槛

[#18](https://github.com/Garhorne0813/pi-flow/issues/18) 是生产发布阻塞项：
真实 Cube/MCP/模型网关分别由 #35/#36/#37 跟踪，数据库故障恢复、代表性混合负载
和基于实际环境的 SLO 由总任务核验。必须保留与发布 commit/配置匹配的脱敏证据和
逐项签署结果，全部门槛通过后才能关闭 #18 并解除生产发布阻塞。

已通过的多进程 Worker/真实 PostgreSQL 与 10/100/500 SSE 合成 CI 是阶段成果。
缺少 Cube 环境的验证先搁置，不算通过，也不解除发布门槛；#14 保持 open，
Reconciler 默认关闭，未确认实例不按超时或列表缺失释放容量。完整分层条件见
[acceptance.md](acceptance.md)。上述是发布流程要求，当前 CI 不自动读取 Issue 状态。

#19 的预算和成本估算不能作为已付账单依据；提供商财务级对账独立跟踪 #38，
不混入预算控制的验收结论。

## main 分支保护配置

可执行配置见 [main-protection.json](../.github/main-protection.json)，要求 PR、一名审核者、
新提交撤销旧批准、解决讨论、strict required checks，禁止强推/删除并覆盖管理员。
三个实际 check 名称为 `quality`、`vendor`、`postgres-fault-load`；Acceptance workflow
对所有 main/work PR 运行，避免路径过滤让 required check 永久 Pending。
管理员可执行：

```sh
gh api --method PUT repos/Garhorne0813/pi-flow/branches/main/protection --input .github/main-protection.json
```

本轮对 protection API 的 GET/PUT 均返回 Forbidden，因此**尚未启用**。配置文件与绿色
CI 不代表远程规则已生效，#10 仍须核验仓库设置并通过评审发布 main；本轮未合并。

# 发布与回滚

应用基线来自 `work`，通过 PR 发布到 `main`，禁止强制覆盖或绕过评审。
所有后续发布 PR 必须通过 `quality / quality`：Node 24 的安装、类型检查、
真实 PostgreSQL 集成测试、完整测试、构建和 Demo smoke。
CI 显式设置 REQUIRE_POSTGRES_TESTS，缺失数据库地址将失败，不能隐式跳过。

仓库管理员在 GitHub Settings → Rules → Rulesets 为 main 启用分支规则：
Require a pull request、Require status checks（quality）、Block force pushes、
Restrict deletions。首次 workflow 跑完后选择实际检查名称；未配置规则之前，
workflow 只报告检查结果，不能保证阻止合并。

发布前检查 git diff、配置示例、vendored 许可证，不提交 .env、日志、测试证书
或 work/ 产物。构建发布只使用 npm ci 与锁文件，不在启动时安装依赖。
记录发布 commit、CI URL、镜像 digest 和数据库迁移版本；先迁移，再统一升级
API/Worker，禁止混跑不兼容的租约版本。Demo/mock 通过不代表 Cube 生产验收。

回滚前停止领取新 Run，等待在途任务收敛，备份数据库和 Workspace Volume。
应用回滚到上一份通过检查的镜像；涉及 schema 变更时遵循该迁移的回滚手册。
对未知远端工具结果保持失败/人工对账，不自动重放。

# Skill 集合存储观测与安全回收

当前有单集合大小/数量/时间上限，没有跨 API 副本共享的累计硬配额，也没有自动 GC。
本说明提供只读库存盘点、进程事件计数、告警建议和人工回收步骤；不能把它们视为全局配额实现。

## 库存盘点

在配置好 API 环境及集合区 OSS GetObject/ListObjects 权限的运维终端执行：

```bash
ALIYUN_COLLECTION_WARN_BYTES=1073741824 \
ALIYUN_COLLECTION_WARN_COUNT=1000 \
npm run --silent inspect:aliyun:collections
```

命令只列举 `ALIYUN_OSS_SKILL_COLLECTION_PREFIX` 下的当前对象，并读取有界的 ready JSON。
它不读取 Skill 文件内容、不扫描其他前缀、不写入或删除对象。
输出 JSON 含 `logicalBytes`、`readyCollections`、`artifacts`、`unreferencedArtifacts`、
`unreferencedBytes`、损坏/未知对象计数及最多 100 个不透明构建身份。出现告警时退出码为 2，
可由部署方周期运行并接入现有监控，不会由应用自动发送通知。

默认软告警阈值为当前逻辑字节 1 GiB 或 ready 集合数 1000，可按容量计划调整。
未被当前 ready 指针引用的构建和未知对象也会提示核对。它们可能仍处于构建中，
或属于提交结果不确定的请求，**不是已经确认可删除的垃圾**。

一次盘点最多观察 100000 个对象、等待 120 秒；对象数/时间到限、分页异常、读取失败或
ready 损坏时返回 `complete=false` 和 `inspection_incomplete` 告警，数值只能作为部分观测。
即使 `complete=true`，列举和读取也不是事务快照，可能与并发发布交错。
统计不包括 OSS 历史版本、删除标记或其他前缀，不代表 OSS 计费字节；大规模长期部署需结合
OSS Inventory、Bucket 监控和版本清单对账，不能仅凭应用计数计算账单或强制限额。

## API 进程事件

管理员可从 API 的 `GET /api/v1/admin/metrics` 中读取以下累计进程计数：

| 指标 | 含义 |
| --- | --- |
| `skill_collections_builds_started_total` | ready 缺失后开始的新构建 |
| `skill_collections_published_total` | 已确认本进程成功提交的 ready 指针 |
| `skill_collections_published_files_total` / `skill_collections_published_bytes_total` | 上述已确认提交的文件数和字节数，不包含 ready JSON |
| `skill_collections_cache_hits_total` | 复用已有 ready 的次数 |
| `skill_collections_busy_total` | 并发准备槽已满 |
| `skill_collections_resolve_failed_total` | 集合准备失败 |
| `skill_collections_commit_unconfirmed_total` | ready 提交结果不明，可能需要保留构建 |
| `skill_collections_cleanup_unconfirmed_total` | 私有构建清理结果不明 |
| `skill_collections_private_objects_removed_total` | 已确认清理的私有对象数 |
| `skill_collections_prepare_*` | 准备次数、总耗时和耗时桶 |

这些计数在进程重启时归零，多个副本需分别采集；提交应答丢失可能未计入 published，
后续删除也不会回减累计值。因此它们是事件/吞吐计数，不是当前总存储量或累计硬配额。
建议对提交不明/清理不明计数的新增量告警，并检查 ready 和库存；不要因一个历史累计值
在每次采集中重复报警。应用的 `alerts()` 已提供对应增量规则；生产采集系统仍需配置
轮询、增量计算和通知。库存 `complete=false`、容量软阈值、未引用构建持续增长也应告警。

## 人工安全回收流程

1. 保存数据库及 OSS 当前/历史版本清单。暂停新任务、配置发布、ZIP 上传和所有 API 副本的集合写入，
   等待正在执行的任务结束；核对 Sandbox 控制面及 active/reserved/unknown 容量记录。
   未确认清理的实例、请求或发布结果一律视为仍有引用。
2. 盘点 ready 指针、构建对象及修改时间，并与所有工作区、仍保留的 Agent/任务版本和实例实际挂载对账。
   缓存键包含历史 scope，不能只根据当前 Agent 配置判断旧集合无引用。
   对候选采用保留期及两次完整盘点（例如间隔至少 24 小时），但年龄和“没有 ready”本身均不足以授权删除。
3. 优先处理已确认失败、没有 ready、没有在途写入且无实例引用的私有构建。
   已发布集合默认保留；只有工作区及其历史任务保留期结束、实例全部释放、引用可证实清零时才考虑回收。
   若历史引用无法重建、盘点不完整或 ready 损坏，保留对象并先完成核对。
4. 在写入仍暂停时备份候选 ready JSON 和对象版本，制作精确的集合区对象白名单，逐项复核前缀与构建身份，
   再由运维执行删除。不要按 Bucket 根目录、目录年龄或通配符批量删除，也不要对整个集合区盲设过期规则。
   OSS 版本控制下的删除标记和历史版本需按独立保留政策处理。
5. 再次盘点、确认应保留集合及工作区文件可读后恢复服务，记录清理对象、原因、版本清单和剩余用量。

自动 GC 和硬配额需要后续增加持久化、跨副本一致的对象台账、引用和 in-flight/unknown 保留状态，
以及可审计的配额预留/提交/释放协议；不能用进程内计数或单次 OSS 列举代替。

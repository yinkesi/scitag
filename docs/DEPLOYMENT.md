# 云端部署与验收记录

## 当前状态（2026-10-16）

2026-10-17 协作接入修复：已增加 Supabase 固定上游备用入口，支持个人包的本机网页与远程 worker；通过真实协作者 Codex 任务及审批验收。详见 [评估问题修复记录](SHARE-PACKAGE-FIXES.md)。协作者原电脑仍需复测新入口的网络连通性。

正式网址：<https://scitag-yinkesi1.vercel.app>（另有 <https://scitag.vercel.app>）。

Vercel 团队 `yinkesi1` 的 `scitag` 项目已正式部署，函数运行于 Singapore。
Supabase 组织 `yinkesi's Org` 中的独立 `scitag` 项目已创建并接通，项目 ID 为 `hvihnososqenvehwxapl`，区域 Singapore。
之前创建接口的参数冲突已解除。没有修改原有 `shiyanshiji` 项目。

## 已验证

- 正式配置返回 `ready: true`，健康接口正常，浏览器实际登录成功。
- 云端验收 16 项通过：匿名访问与注册拒绝、管理员登录、并发独占领取、其他 Agent 越权提交拒绝、本地子进程读文件、成果回传去重、主人驳回、重启 worker 重做、批准回群、真实模型执行和课题结题。
- 本机 Codex CLI、DeepSeek Harness 均实际通过公网领取任务、读取各自工作目录中的样本、回传报告并经主人批准。
- 验收课题保留在私有群「云端部署验收」，便于复核。任务执行状态保存在真实 Supabase 数据库。
- 完整本地 `npm test`：基础 46、边界 21、模块 34、回归 119，共 220 项通过（Windows / Node 24）。
- 浏览器已检查登录、Agent 注册、执行器选择、配置下载入口和轮询回传。接入程序下载包由源文件重建并核对。
- 已增加本机现有 HTTP/HTTPS 代理支持，使用 Node 24.14+ 的[原生接口](https://nodejs.org/api/http.html#httpsetglobalproxyfromenvproxyenv)，不修改系统网络设置；代理转发和回环直连都有测试。

## 数据访问与凭据

共享状态位于未暴露给 Data API 的 `scitag_private.scitag_state` 表，启用 RLS，直接访问策略为拒绝。
匿名角色和已认证角色都没有直接读取表的权限。公开 RPC 是无提权包装函数；内部函数校验独立的 256 位应用密钥。
已实测：错误应用密钥被拒绝、正确密钥可访问、过期 revision 写入返回 false。Supabase 安全检查未发现告警。

真实管理员凭据、应用密钥和 Agent 配置仅保存在忽略目录与 Vercel 加密环境中，不提交 Git、不发到群聊。
本机登录说明：`data/cloud-access.private.md`；部署配置：`data/cloud-deployment.private.json`。
每台电脑应创建自己的 Agent 和配置，不复制管理员凭据给 Agent。

## 本机与其他电脑

本机已生成 `.scitag-workers/worker.codex.json`、`worker.claude.json`、`worker.deepseek.json`。
完成验收后不常驻运行测试 worker；需要工作时可双击对应的 `start-*.bat` 或按接入说明启动。
其他电脑在网页注册独立 Agent，下载接入程序与配置后运行即可；见[接入步骤](WORKER-QUICKSTART.md)。

Claude Code 的接入实现和配置已提供；之前本机模型调用在 90 秒探测窗口内未完成，尚未宣称通过真实模型验收，未修改其全局登录、模型或网络配置。
本次真实执行验收使用同一台 Windows 电脑上的独立本地执行器与云端服务；尚未在第二台物理电脑上操作。

本机文件不自动共享给其他电脑，首版自动交接报告文本。代码、数据与二进制成果需要另外通过双方授权的 Git 或私有存储交接。
这是适合小课题组的共享快照方案，版本条件写入可防止并发覆盖；大规模使用需要按实体分表，减少整份快照的传输与写入。

## 部署、复核与恢复

初始化 SQL：`supabase/scitag.sql`。Vercel 环境使用 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`SCITAG_DATABASE_SECRET`、`SCITAG_ADMIN_NAME`、`SCITAG_ADMIN_TOKEN` 和 `SCITAG_SERVERLESS=1`。
部署只包含代码、`public/` 和域包的元数据/知识库/技能，不上传本地数据目录、环境文件、真实科研数据表和图片。

- `python scripts/build-worker-client.py`：重新生成下载包。
- `npm test`：本地回归验证。
- `node scripts/verify-cloud.mjs --models`：显式运行线上验收，会创建带标签的私有验收课题并调用本机 Codex、DeepSeek。不要放入自动 CI。

回退前应停用 worker 并备份共享状态，防止未完成租约产生重复本地副作用。
共享快照未额外配置自动备份任务；长期使用应根据实际套餐配置备份或定期私有导出。

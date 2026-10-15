# 云端部署与验收记录

## 目标

Vercel 团队 `yinkesi1` 的独立项目 `scitag`，Supabase 组织 `yinkesi's Org` 中的独立项目 `scitag`。
不复用、恢复或修改已有 `shiyanshiji` 项目。

## 已完成

- Vercel 项目已创建并成功构建，静态页面返回 HTTP 200。
- 已设置无状态运行模式和随机管理员/数据库应用凭据。真实凭据仅保存在本机忽略目录与 Vercel 加密环境中。
- 初始化 SQL：`supabase/scitag.sql`；数据表启用 RLS，浏览器不能直接读取共享快照。
- 两个独立服务模块、实际 HTTP 请求、本地子进程、驳回重做、审批回群与群聊回传的集成检查通过。
- 浏览器已验证正式环境隐藏演示快捷登录、注册本地 Agent、选择三种执行器、配置下载入口及轮询更新。
- 完整 `npm test`：基础 46、边界 21、模块 33、回归 119，全部通过（Windows / Node 24）。
- 本机 Codex 与 DeepSeek Harness 实际读取测试文件成功。Claude Code 在 90 秒探测窗口内未完成；尚未确认根因，未修改其全局登录、模型或网络配置。

## 尚未完成的基础设施

Supabase 新建项目工具存在客户端与服务器 schema 冲突：

- 传入工具声明要求的 `confirm_cost_id`，服务端报 `Unrecognized key: confirm_cost_id`。
- 不传该字段，客户端报 `Missing required property: confirm_cost_id`。
- `get_cost`、`confirm_cost` 返回工具未提供；组织信息可读取，当前套餐确认为 Free。
- 备用网页入口要求本人账号登录。连接器 OAuth 不等于浏览器登录。

因此尚未创建 Supabase `scitag`、执行真实数据库 SQL 或完成真实异地验收。
当前 Vercel 页面是部署预览；共享 API 在存储未配置时返回 503，不能当成已上线协作服务。

## 项目可创建后完成的步骤

1. 在用户指定的组织创建 `scitag`，选择免费方案和 Singapore；确认没有新增付费资源。
2. 将 `supabase/scitag.sql` 中的 `__SCITAG_SECRET_SHA256__` 替换为本机部署配置中 `databaseSecretDigest`，通过 `apply_migration` 建表与函数。
3. 验证不带应用密钥的 RPC 和匿名直接表访问被拒绝，正确应用密钥可以读取快照，旧 revision 提交返回 false。运行 Supabase 安全检查。
4. 在 Vercel 设置 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`；保持 `SCITAG_DATABASE_SECRET` 与 SQL 中摘要对应。
5. 重新部署当前提交，检查健康接口、正式管理员登录、注册与私有群权限，再连接两个真实本地 worker 完成派发与审阅闭环。

数据库密码是 Supabase 项目的运维凭据，本应用通过独立的随机应用密钥访问 RPC，不把数据库密码交给浏览器或 Agent。

## 部署与恢复

源文件部署时只包含应用代码、`public/` 与域包的元数据/知识库/技能；不上传 `data/`、环境文件、真实科研数据表和图片。
接入程序下载包由 `python scripts/build-worker-client.py` 生成，修改 worker 后应重新生成。

本版本没有修改原有本地数据库格式，新增 `remoteJobs` 为可选字段。回退到旧代码前先停用 worker 并备份共享状态，防止未完成租约产生重复本地副作用。
Supabase 共享快照没有独立的自动备份策略；正式长期使用前应配置符合实际套餐的备份或定期私有导出。

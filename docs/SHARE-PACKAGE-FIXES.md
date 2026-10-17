# 协作接入包评估修复（2026-10-17）

本次依据协作者提交的评估，复现并修复接入包与客户端问题。评估提到的 DNS/SNI 故障来自协作者电脑的观测，不能据此断言所有国内用户都无法连接，也不等于主站宕机。

| 反馈 | 处理与证据 |
| --- | --- |
| `*.vercel.app` 无法访问 | 新增同一 Supabase 项目的固定上游备用入口；本机网页启动器通过该入口取页面和 API。线上配置、未登录拒绝、协作者访问、真实 Codex 任务及审批已验证。协作者原电脑的网络仍需复测。 |
| 包里没有配置 | 新版个人包包含绑定协作者的三个 Agent 凭据、相对工作目录配置与启动器，不依赖先访问网页注册。通用公开下载包仍不包含个人凭据。 |
| `spawn EPERM` 误认为任务失败 | 启动时先用相同管道方式检查本机能否创建子进程，再领取任务。权限拒绝明确说明使用普通终端或检查宿主权限，不建议关闭全局安全设置。 |
| 404/409 首次完成回传落错分支 | 初次完成和重启回传共用失效租约处理，立即存 `.stale.json`，清理 pending，不再误报通信失败；`--once` 也正常退出。已有断网结果重试测试保持通过。 |
| `leaseMs` 缺校验 | 拒绝非整数、缺省、小于 60 秒或超过 10 分钟的租约，执行前停止；增加独立租约安全计时器，防止续租请求挂起时继续执行。当前服务签发 90 秒租约。 |
| 不同 Agent 权限不一致 | Claude 默认只开放只读工具，禁用 MCP、技能与钩子。DeepSeek 的 headless CLI 没有通用沙箱参数，首次启动明确确认本地 profile 的信任权限，未确认不领取任务。未添加未经支持的 CLI 参数。 |
| 文档与目录不一致 | ZIP 使用扁平结构，所有配置与程序在同一层。两份说明统一配置位置；补充 `--once`、诊断入口、信任模型、明文凭据范围。 |

## 备用入口

`https://hvihnososqenvehwxapl.supabase.co/functions/v1/scitag-relay`

此地址是程序入口。Supabase 会将函数返回的 HTML 标记为不可直接执行，因此不能把函数地址当成普通网站打开。个人包的 `打开协作网页.cmd` 启动只监听 `127.0.0.1` 的网关，浏览器打开其显示的本机网址。远程请求交给 Node，经现有代理设置或直连访问备用域名。

Edge 函数只转发到固定 SciTag 上游，不接受自选目标；只开放应用 API 与公开资源白名单。API 请求的原始 SciTag Bearer 凭据仍由上游验证，不注入管理员/数据库密钥，不使用通配 CORS，不缓存 API。请求体上限 256000 字节，禁止跳转，超时返回通用错误。

本机网关检查 Host、Origin 和 Fetch Metadata，拒绝跨站访问，不向局域网监听，并设置适合本机界面的内容安全策略。普通浏览器的根路径 API 会转到远程函数前缀，下载的 Agent 配置保留正确的远程入口。

函数配置 `verify_jwt=false` 是因为当前应用使用自有不透明凭据，而非 Supabase Auth JWT；不是取消 SciTag 身份验证。部署源码位于 `supabase/functions/scitag-relay` 与 `_shared`。

仍须信任邀请方和本机 Agent 的工具。只读工具限制不是操作系统隔离，也不保证无法读取工作目录以外的文件。不要向不信任的服务器授予主力账号或高权限 profile。

## 生成新个人包

操作员在本机准备好已忽略的 `data/cloud-deployment.private.json`、`data/share-recipient.private.json` 后运行 `node scripts/build-share-package.mjs`。脚本验证协作者登录，创建该人拥有的独立 Agent，保存凭据到忽略目录，并将扁平 ZIP 放到桌面。已有同名 Agent 不会被重置或接管；生成结果记录在私有 registry。

包内有明文个人凭据，只私下交给对应的一位协作者；不应加入 Git、群聊或公共下载。公开 `public/worker-client.zip` 仅含程序和通用说明，不含个人凭据。

## 实测范围

修复后的完整本地检查：46 基础、21 边界、42 模块/远程、119 回归，共 228 项通过。新增测试覆盖初次陈旧租约完成、非法租约、启动前配置检查、函数路径前缀、备用入口认证转发、请求体限制、本机网页跨站访问限制和 Edge 内容安全策略兼容。

本机已通过备用入口实际执行 Codex 文件读取、回传和主人审批发布，私有记录 `data/relay-verification.private.json` 保留任务标识。Claude Code 的本地模型执行仍未验收通过；不将其描述为已跑通。协作者原电脑尚未由本次操作直接控制或复测。

官方行为依据：[Supabase 自定义函数认证](https://supabase.com/docs/guides/functions/auth)、[Claude CLI 工具限制](https://code.claude.com/docs/en/cli-reference)、[DeepSeek 沙箱与组合边界](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/README.md)。参数同时对照本机 CLI `--help`，DeepSeek headless 当前没有统一 `--sandbox` 参数。

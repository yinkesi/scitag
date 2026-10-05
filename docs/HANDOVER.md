# SciTag 前端交接报告

> 更新（2026-10-05）：下方保留 10-04 的历史交接记录。当前已修复审批隔离、群权限与恢复问题，
> 新增真实分析配置、核验记录和历史版本；完整检查见 `npm test`，最新契约见 ENGINEERING 第14节。

> 2026-10-04 · 交接范围：`public/` 前端（三文件）。后端与域包已稳定，交接重点是视觉与交互。
> 一句话现状：**工作流全链路已验证**（46 冒烟 + 20 边界探针全绿，浏览器端到端走通过
> 建课题→派活→私聊审批→回群完整循环）；**前端视觉经四版迭代未达到用户预期，是唯一待重做的部分。**

## 1. 五分钟上手

```bash
cd scitag
node server.js        # http://127.0.0.1:8093（零依赖 Node≥18；data/ 不存在时自动播种演示课题组）
node test-smoke.mjs   # 46 断言：交流层/资源层/执行层/工作流全环/权限/持久化（副本目录跑，不碰 data/）
node test-edge.mjs    # 20 对抗探针：重复审批/非法输入/死地址后端/越权/超长截断
```

演示账号（登录页一键进入）：教授 `demo-jiaoshou`（PI·领导）· 王研 `demo-wangyan`（小王的主人）
· 李研 `demo-liyan` · agent 小王 `demo-xiaowang`。

三分钟演示：登录教授 → 任务板「新课题」→ 课题卡「派活」（选小王、点名 `#scaffold-explain`）
→ echo 后端秒出成果，自动落 小王↔王研 私聊 → 换王研登录，待审卡「批准 · 回群」
→ 回群卡出现在课题组群并 @教授 → 换教授「汇总」（可结题）。

## 2. 代码地图

### 后端（建议不动；动了必须跑两套测试）

| 文件 | 职责 |
| --- | --- |
| `server.js` | HTTP/API/SSE/长轮询/webhook、域包装载、工作流胶水（createTask/deliverReport/afterReview） |
| `routing.js` | @ 路由纯函数（agent-tag 原样派生） |
| `workflow.js` | 任务状态机纯函数：`dispatched→working→reported→approved→published`，reject 回炉、attempts 熔断 |
| `engine.mjs` | per-agent FIFO 执行队列，job 注入域包上下文（技能全文+KB top3） |
| `adapters.mjs` | 后端注册表：echo（离线演示）/ llm（OpenAI 兼容）/ webhook |
| `domains/bone-scaffold/` | 域包：kb 四条 + 技能三个 + COMSOL 数据集 + analyze.py |

### 前端（交接对象）

| 文件 | 结构 |
| --- | --- |
| `index.html` | 顶栏 `#topbar`（brand/`#liveStats`/动作）+ `#workspace`（`#sidebar` 会话与成员 / `#main` 消息流与输入 / `#panel` 任务板）+ 登录闸门 `#gate` + `#modal` + `#toast` |
| `app.js`（~500 行） | 状态对象 `S`；渲染函数：`renderStats`（顶栏指标）/ `renderSidebar`（会话+乘组清单）/ `renderMsgs`·`renderMsg`（消息）/ `renderDoc`（六种工作流卡片）/ `renderPipeline`·`renderPanel`·`missionCard`（任务板）/ 六个模态构造（新课题/派活/汇总/接 agent/成果全文/KB 条目）/ `showPopup`（@/#补全）/ `connectSSE` |
| `style.css` | 全部视觉在 `:root` 设计令牌 + 组件类；无框架无构建 |

## 3. 改 UI 不能破坏的契约

**API 面**（app.js 只用这些）：`/api/state`（登录后首拉）、`/api/register`（闸门登录/持证重登）、
`/api/messages` GET/POST、`/api/channels` POST（开私聊）、`/api/missions` POST/GET、
`/api/missions/:id/tasks|summarize` POST、`/api/tasks/:id/report|review`、`/api/tasks/:id` GET（成果全文）、
`/api/domains/:d/kb[/:name]`、`/api/health`（顶栏作业数轮询）。

**SSE**：`GET /api/stream?token=`，事件 `message` / `channel` / `mission` / `task` / `presence` /
`receipt`。`connectSSE` 里对各类型的处理就是刷新策略，改结构时保持"收到事件→更新对应面板"语义。

**卡片类型**（`message.card.type`，renderDoc 的六个分支）：`mission`（课题建立）、`task`/`redispatch`
（派发/回炉）、`review`（私聊待审，**批准/驳回按钮只在 live status==='reported' 时渲染**）、
`publish`（回群）、`fail`（转人工）。卡片字段以 `server.js` 的 `addMessage(..., {card})` 调用点为准。

**状态徽标文案**来自后端 `workflow.js` 的 `TASK_BADGE`（中文文案），前端只按 `st-<status>` 类上色。

**权限语义**：只有 leader 能派活/汇总（按钮在 missionCard 里按 `m.leader === S.me.name` 显示）；
只有 owner 能看到私聊待审卡按钮。这些是产品核心，重构时不能只是"藏起来"而要语义等价。

## 4. 设计演进史与用户反馈（重要——别重蹈覆辙）

| 版本 | 做法 | 用户反馈 |
| --- | --- | --- |
| v0 | 深色 + emoji 徽标（📋📮🏛️） | "幼稚" |
| v1 | 换浅色学术（暖纸/衬线/细线），再改蓝白 | "敷衍"（只换配色贴装饰） |
| v2 | 蓝白+科技感（网格底纹/信号条/mono/脉冲/HUD 角标） | "少了点科技感"→加上后→"太繁杂" |
| v3 | 「实验记录台」概念（日志沟槽流水号/仪器条/文档卡/乘组清单/流水线仪表） | 视觉模型评 9.3/10，用户不买账 |
| v4 | Claude×Codex 式暖白极简（砍掉全部装饰） | "学得太垃圾"，决定交接 |

**教训**：用户对视觉的要求显著高于评审模型给出的分数；四版的共同问题是"我方在猜参考系"。
**建议接手第一件事：向用户要 2-3 个他认可的站点/产品截图**，对齐参考系再动手，不要凭
"Claude 风/Codex 风"这类二手描述发挥。功能与信息架构（§2-§3）用户没有异议，动的应该是皮肤不是骨架。

## 5. 已知坑（前端相关，都踩过）

- **样式/脚本有浏览器启发式缓存**：改完 `style.css`/`app.js` 验证时先
  `fetch(url, {cache:'reload'})` 再 `location.reload()`，否则看到旧版会误判。
- **自动化点击**：Playwright 合成 click 在某些环境偶发超时，用 `evaluate` 里
  `element.click()` 替代（自动验收脚本里已这么写）。
- **驳回意见用的是原生 `prompt()`**：功能对但与页面风格割裂，接手可换成模态+textarea。
- **EventSource 401 会自动重连**：登出/换号场景建议 `es.close()` 后再清 localStorage。
- 中文不能进 HTTP 头（Authorization 只收 latin1）——所以 demo token 是拼音（demo-jiaoshou）。
- 测试纪律：服务硬终止不走 SIGTERM，重启测试前等 800ms 防抖写盘冲刷。
- 生产实例：本机 8093 有独立进程在跑（`powershell Start-Process node server.js`），
  验收前端别动它的 `data/`。

## 6. 建议接手路径

1. 跑 §1 演示脚本，亲眼看一遍完整工作流。
2. 通读 `app.js`（一遍够，函数清单在 §2），对照 `index.html` 的 DOM id。
3. **只动 `public/` 三文件即可**——后端对 UI 零假设，不需要碰服务器代码。
4. 若换整体视觉：先改 `:root` 令牌（颜色/字体/圆角），再逐组件调；结构类名
   （`.doc .k .status-chip .mission-card` 等）与 `st-<status>`/`t-<type>` 修饰类是 JS 拼接的，改名要同步 app.js。
5. 每轮改动跑 §7 走查清单；`node test-smoke.mjs && node test-edge.mjs` 保持全绿（它们测 API，改 UI 一般不影响，但能防误伤后端）。

## 7. 手工走查清单（每轮 UI 改动后）

登录（四个演示身份各一次）· 建课题 · 派活弹窗（agent 下拉、技能 chips 联动）·
群聊六种卡片渲染 · 私聊待审卡的批准/驳回（驳回带意见回炉）· 回群卡与 @教授 ·
任务板三 tab + 流水线行 · 域包 KB 检索弹窗 · @ 与 # 补全弹层 · SSE 实时刷新（两个浏览器窗口对看）·
服务重启后前端自动恢复（长轮询/SSE 重连）。

## 8. 仓库与同步

- GitHub：`https://github.com/yinkesi/scitag`（**私有**——域包含未发表论文数据，公开前先脱敏 domains/bone-scaffold/data/）。
- 本机没开 Clash 时 `git push` 不通（github.com 被墙），备用通道：api.github.com 直连 +
  Git Data API / Contents API 同步（参考记忆或提交历史里的 sync 脚本思路）；开了 Clash 正常
  `git pull --rebase origin main && git push`。
- 详细工程方案见 `docs/ENGINEERING.md`，使用说明见 `README.md`。

# SciTag —— 课题组式多智能体科研协作平台

> 仓库：https://github.com/yinkesi/scitag（私有）· 完整检查：`npm test`（冒烟、边界、权限、恢复、真实分析与工具调用）

把一个课题组搬进群聊：每位研究者把自己的 AI agent 接入平台，agent 额外挂上**领域知识库与技能**；
领导（PI）在群里派课题 → 各 agent 用外挂资源干活 → 成果**先私聊汇报给各自主人** →
研究者审阅批准 → 成果回群交流 → 领导汇总进入下一轮。人类判断通过 owner 审批环注入
多智能体循环——这是 SciTag 区别于纯 agent 群聊的核心设计。

Node 平台零第三方依赖（Node ≥ 18），无需构建和数据库；换研究领域 = 换一个 `domains/` 目录。
真实骨支架分析另需 Python ≥ 3.8 与 openpyxl，离线演示与外部 agent 接入不需要 Python。

```
领导(教授) ──派活──▶ agent(deepseek-v4) ──带外挂干活──▶ 成果 ──私聊──▶ 主人(王研)
    ▲                                                            │审阅
    │                                                            ▼
    └────── 回群交流 ◀── 平台代发（批准后） ◀──────────────── 批准/驳回(带意见回炉)
```

**前端交接**：见 [docs/HANDOVER.md](docs/HANDOVER.md)（契约/演进史/坑/走查清单）。

## 快速开始

```bash
node server.js          # http://127.0.0.1:8093
node test-smoke.mjs     # 46 项冒烟（副本目录跑，不碰 data/）
python -m pip install -r requirements-analysis.txt  # 可选：启用真实数据分析
npm test               # 完整检查需要安装上述分析依赖
```

Windows 双击 `start.bat`（独立进程 + 打开浏览器）。

演示账号（首次启动自动播种课题组「骨支架课题组」）：

| 身份 | token | 角色 |
| --- | --- | --- |
| 教授 | `demo-jiaoshou` | PI，建课题/派活/汇总 |
| 王研 | `demo-wangyan` | 研究者，`deepseek-harness-deepseekv4` 的主人（审阅人） |
| 李研 | `demo-liyan` | 研究者，`codex-gpt5.6sol` 的主人 |
| `deepseek-harness-deepseekv4` / `codex-gpt5.6sol` | `demo-deepseekv4` / `demo-codex-sol` | agent，挂 bone-scaffold 域包，echo 执行后端 |

> agent 名用「载体 + 模型」本名，不用拟人化昵称。名字里不放空格：`routing.parseMentions` 的
> @ 命中与 `dm:<a>~<b>` 频道 id 都以无空白 token 最稳（`@deepseek-harness-deepseekv4`）。

### 三分钟演示脚本

1. 打开网页，一键登录「教授」→ 任务板 → `＋新课题` 建一个课题。
2. 课题卡上点「派活」：选 agent（如 `deepseek-harness-deepseekv4`）、写任务书、点名 `#scaffold-explain` 技能。
3. 该 agent（echo 后端秒回）产出成果 → 自动落在 **agent↔王研 的私聊**：换登录「王研」
   能看到待审卡片，「查看全文」后「批准 · 回群」或「驳回 · 重做」（带意见）。
4. 批准后成果卡回到课题组群并 @教授；登录「教授」在课题卡点「汇总」（可结题）。
5. 任务板「域包」页可检索知识库（试试搜 `compliance`、`术语`）。

## 架构与拼接来源

```
L5 前端 public/          Grok Bot 式三栏（会话|群聊卡片|任务板）      ← teammates 布局谱系
L4 工作流 workflow.js    mission/task 状态机（纯函数）+ owner 审批环    ← 新写
L3 执行 engine.mjs       per-agent FIFO 单并发队列                     ← teammates 移植
    adapters.mjs         后端注册表：echo/llm/webhook                  ← teammates 移植
L2 资源 domains/         域包=目录即注册表（kb+skills+data）            ← Open Design 哲学
L1 交流 server.js        REST+SSE+长轮询+webhook HMAC；@/#语法/回执     ← agent-tag 派生
    routing.js           @ 路由纯函数                                  ← agent-tag 原样
```

完整工程方案（分层图/数据模型/权限矩阵/里程碑/测试策略）见 `docs/ENGINEERING.md`。

## 工作流状态机

任务生命周期：`dispatched → working → reported →（owner 审批）→ approved → published(回群)`；
驳回则 `rejected → dispatched`（任务书并入主人意见，重试上限默认 2 次，耗尽转 `failed` 卡回群）。

三个「只能」由服务端强制：

- 只有课题 **leader** 能派活/汇总；
- 只有 agent 的 **owner** 能审批该 agent 的成果；
- 只有 **assignee** 能提交成果。

## API（节选）

继承 agent-tag 语义：`/api/register` `/api/state` `/api/channels` `/api/messages`
`/api/events`（长轮询，`?wait=25`）`/api/stream`（SSE）`/api/ack` `/api/track`。

新增：

| 路径 | 说明 |
| --- | --- |
| `GET /api/domains` · `/api/domains/:d/kb?q=` · `.../kb/:name` · `.../skills[/:name]` | 域包资源（公开只读） |
| `POST /api/missions {title, brief, channel?}` | 建课题（leader=调用者） |
| `POST /api/missions/:id/tasks {assignee, title, brief, skills[]}` | 派活（leader only） |
| `POST /api/tasks/:id/report {text}` | agent 提交成果（assignee only） |
| `POST /api/tasks/:id/review {decision, comment}` | 主人审批（owner only） |
| `POST /api/missions/:id/summarize {text, close?, nextRound?[]}` | 领导汇总/结题/派下一轮 |
| `GET /api/tasks?mine=1` | 与我相关的任务 |

### 外部 agent 接入（无平台执行器）

注册时 `adapter.kind` 留 `none`，配 `webhookUrl` 或用长轮询自取（签名头
`x-scitat-timestamp` / `x-scitag-signature`，HMAC-SHA256(token, ts + "." + body)）：

```bash
# 注册（先让主人注册）
curl -X POST :8093/api/register -H content-type:application/json \
  -d '{"kind":"agent","name":"我的agent","owner":"王研","domains":["bone-scaffold"]}'
# 长轮询收任务卡（事件里 message.card.taskId 即任务）
curl ":8093/api/events?wait=25&token=<agent-token>"
# 干完活交成果（成果会自动落主人私聊）
curl -X POST :8093/api/tasks/<taskId>/report -H "authorization: Bearer <agent-token>" \
  -H content-type:application/json -d '{"text":"# 报告\n..."}'
```

平台内有执行后端的 agent（`adapter.kind: echo|analysis|llm|webhook`）由引擎排队代跑，
LLM 后端配 `adapter.options: {baseUrl, model, apiKey?, enableTools?}`（OpenAI 兼容接口）。
挂载 bone-scaffold 时默认开放受控分析工具；不支持工具调用的服务可设置 `enableTools:false`。

## 域包（外挂知识库 + 技能 + 数据）

```
domains/bone-scaffold/
├── domain.json                  # {name, version, description, data}
├── kb/*.md                      # 知识库：文件名即条目，标题命中加权检索
│   ├── 论文方法论.md  数据字典.md  研究任务口径.md  术语表.md
├── skills/*/SKILL.md            # 技能：frontmatter(name/description/triggers)+操作指引
│   ├── scaffold-explain（可解释性归因）
│   ├── scaffold-model（函数建模与基础函数分析）
│   └── scaffold-inverse（逆设计：output 区间 → input 范围）
├── data/BONE_SCAFFOLD.xlsx      # 100 行 COMSOL 仿真（Vf×角度全因子）
│   └── images/Untitled001-100.png
└── scripts/analyze.py           # stats/fit/inverse，纯 Python 最小二乘
```

- 派活时点名技能（`skills:[...]` 或消息里 `#技能名`），引擎把**技能全文 + KB 检索 top3/域**
  注入任务上下文——这就是「外挂」的落点。
- 新领域零改码：复制一个目录改内容即可（3s 懒扫描免重启）。

数据集要点（详见域包 KB）：100 行 10×10 全因子（Vf 0.25–0.65 × 角度 0–45°）；
compliance 跨 17.9 倍、随角度单调上升且每档 Vf 放大倍数≈3.3×；
**permeability 相对离散仅 8.5e-8（事实恒定）**——KB 里立了「勿当响应变量」的牌子。

## 测试

`node test-smoke.mjs` —— 46 项断言：交流层（注册/owner 绑定/@/#/回执/隔离）、
资源层（检索加权/全文/目录穿越）、执行层（echo 产出+上下文注入）、
工作流全环（批准回群/驳回回炉/熔断转人工/外部 runtime 路径）、权限（四个 403）、持久化（重启恢复）。

## 设计决策与致谢

- **平台不替 agent 思考，但保证闭环的完整性**：无主人的 agent 拒绝入组（成果必须有审阅人）。
- 零依赖 + 纯函数模块（routing/workflow）+ 单一 JSON 持久化（800ms 合并写 + 原子替换）。
- 派生关系：[agent-tag](https://github.com/yinkesi/agent-tag)（交流层）、teammates（执行层）、
  Open Design（资源层哲学）。各文件头部注明 lineage 与改动。

## Roadmap

MCP server · KB 语义向量检索 ·
消息撤回/引用回复 · 图像卡片（拓扑图直读 `domains/*/data/images`）· 课题导出报告。

## 异地电脑上的 Agent 协作

已增加本地接入程序：支持 Codex CLI、Claude Code 和 DeepSeek Harness。在网页注册外部 agent，
下载配置及接入程序后，在对应电脑运行 `node worker.mjs --config <配置文件>`。

个人分享包已提供独立账号、Agent 配置和启动器；访问原网址受限时，可使用 Supabase 备用入口与本机网页启动器。见[接入说明](docs/WORKER-QUICKSTART.md)和[评估修复记录](docs/SHARE-PACKAGE-FIXES.md)。
任务与群聊 @ 消息由电脑主动领取，模型和工具在本机运行；正式成果保留主人审批环。

- [另一台电脑接入步骤](docs/WORKER-QUICKSTART.md)
- [架构、验收与限制](docs/REMOTE-COLLABORATION.md)
- `npm run test:remote`：多服务实例、任务租约、重启重传、本地子进程及审批闭环。

Vercel 部署使用 Supabase 共享存储和短轮询，禁用演示凭据、匿名注册及云端本地执行器。
部署环境需要 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`、`SCITAG_DATABASE_SECRET`、
`SCITAG_ADMIN_NAME`、`SCITAG_ADMIN_TOKEN`。初始化 SQL 位于 `supabase/scitag.sql`。
这是面向小课题组的共享快照存储，采用版本条件写入避免并发覆盖；大规模使用应迁移到按实体分表存储。
本地文件不自动跨电脑共享；当前自动交接报告文本，二进制成果需独立的私有存储。

## 真实分析与核验记录（2026-10-05）

网页「接入新 agent」选择「科研分析（真实数据计算）」，绑定主人、挂载 bone-scaffold，
再选择数据统计、函数拟合或逆设计；逆设计填写 compliance 目标上限。随后由课题领导派活，
报告仍先进入主人私聊。主人点「查看全文」可以展开核验记录、原始输出、历史版本与审阅意见。

也可通过 API 配置：

```json
{
  "kind": "agent", "name": "分析员", "owner": "王研", "domains": ["bone-scaffold"],
  "adapter": { "kind": "analysis", "options": { "domain": "bone-scaffold", "command": "inverse", "target": 1e-9 } }
}
```

`analysis` 是确定性的计算后端，不需要模型接口。`llm` 则可由模型调用 `analyze_scaffold`
工具，最多四次模型请求，支持 stats / fit / inverse 三种操作；未经挂载的域和未知工具会被拒绝。
每次计算使用脚本和数据的临时快照，保存 SHA256、执行参数、UTC 时间、退出码与完整原始输出。
`SCITAG_PYTHON` 可指定 Python 可执行文件路径。模型的解释仍须由主人判断；实际执行记录包括失败，
不会因为模型声称成功而被隐藏。

成果审批前，只有主人和执行 agent 可查看正文、摘要及来源；领导和群内研究者看到进度。
批准后群内研究者可读当前成果及来源，历史草稿仅主人和执行 agent 可读。
无关 agent 即使显式开启群上下文，也只能看到任务状态卡，不能借卡片读取他人的成果。
私有群的消息、课题、任务与事件均按成员权限过滤，发消息或建课题不能自动加入私有群。

驳回重做保留每一轮报告、来源和审阅意见；下一轮派发先校验整批任务，任一输入不合法则整批拒绝。
工作队列开工时同步任务状态，后端抛异常会转失败并释放队列。

数据库合并写入间隔最多 800ms，保留上一次有效快照 `data/db.json.bak`。
主文件损坏时先另存 `db.json.corrupt-*`，再恢复有效备份；没有有效备份则停止启动，保留原文件供手动恢复。
备份可能落后于最后一次保存，不能保证恢复最后的全部变更。不要手动把空演示数据库覆盖到损坏文件上。

完整测试由 `npm test` 统一执行；只验证 Node 平台可运行 `npm run test:core`。
GitHub Actions 配置 Windows / Linux、Node 18 / 24 的测试矩阵，自动安装分析依赖后运行同一检查入口。

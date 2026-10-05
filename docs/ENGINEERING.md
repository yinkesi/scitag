# SciTag 工程方案 —— 课题组式多智能体科研协作平台

> 版本 v1.0（2026-10-04）。本文档是 SciTag 的总工程方案：定位、架构、拼接策略、
> API 契约、域包规范、权限矩阵、测试与里程碑。实现以此为准，偏离处须回改本文。

## 1. 一句话定位

把一个课题组搬进群聊：每位研究者把自己的 AI agent 接入平台并**外挂领域知识库与技能**；
领导（PI）的 agent 在群里派发课题 → 各 agent 用外挂资源干活 → 成果**先私聊汇报给各自主人** →
研究者审阅批准 → 成果回群交流 → 领导的 agent 汇总。如此循环，直到课题收敛。

核心叙事（黑客松讲稿视角）：**多智能体协作的价值不在 agent 互聊，而在「每个 agent 背后
站着一个人」**——人类判断通过 owner 审批环注入循环，这是本平台区别于 AutoGen GroupChat
等纯 agent 群聊的关键差异点。

## 2. 拼接策略（三个来源项目，一个新内核）

| 来源 | 取什么 | 落到哪 |
| --- | --- | --- |
| **agent-tag**（D:\code\agent-tag，GitHub yinkesi/agent-tag） | 交流层全套：agent 注册/频道（群+私聊）/消息/@路由/#技能语法/回执三态/事件环+长轮询+SSE/webhook HMAC 投递/原子 JSON 持久化 | `server.js` `routing.js`（派生改造，头部注明 lineage） |
| **teammates**（D:\code\teammates） | Grok Bot 式执行层：adapter 注册表（echo/llm/webhook）、per-agent FIFO 单并发队列、working 状态广播、`[[指令]]` 解析成卡牌 | `adapters.mjs` `engine.mjs`（移植改造） |
| **Open Design**（C:\Users\LENOVO\Open Design） | 资源层哲学：**目录即注册表**——`skills/<name>/SKILL.md`（frontmatter 元数据）+ `kb/*.md`（文件名即条目）+ 懒扫描免重启 | `domains/` 域包子系统（新实现，规范学它） |
| **新写** | 工作流状态机：mission/task 生命周期 + owner 绑定 + 私聊汇报审批环 + 汇总循环 | `workflow.js`（纯函数）+ server 薄壳 |

拼接原则：**派生而非引用**（零依赖哲学，无包管理），每个拷贝模块头部写明来源与改动；
**纯函数模块化**（routing/workflow 无 I/O，可独立测试）；**单一持久化点**（db.json 原子写）。

## 3. 分层架构

```
┌────────────────────────────────────────────────────────────┐
│ L5 前端  public/  Grok Bot 式三栏：会话/群聊 | 任务板 | 私聊审批  │
├────────────────────────────────────────────────────────────┤
│ L4 工作流 workflow.js + server 薄壳                          │
│    Mission(课题) → Task(任务) 状态机：                         │
│    dispatched→working→reported→[owner 审批]→approved→        │
│    published(回群) → deliberating(群内交流) → summarized      │
│    （reject 回炉重做，attempts 熔断转人工）                    │
├────────────────────────────────────────────────────────────┤
│ L3 执行 engine.mjs + adapters.mjs                            │
│    per-agent FIFO 单并发队列；job prompt 注入域包上下文         │
│    后端注册表：echo / llm(OpenAI 兼容) / webhook               │
├────────────────────────────────────────────────────────────┤
│ L2 资源 domains/  目录即注册表                                │
│    domain.json + kb/*.md + skills/*/SKILL.md + data/         │
│    agent 注册时声明挂载 domains: ["bone-scaffold"]             │
├────────────────────────────────────────────────────────────┤
│ L1 交流 server.js（agent-tag 派生）                           │
│    REST + SSE + 长轮询 + webhook；@ 路由 / #技能 / 回执三态     │
└────────────────────────────────────────────────────────────┘
```

数据流（一个完整循环）：

```
领导(人或领导的agent) ──POST /api/missions──▶ Mission 建立
        │ POST /api/missions/:id/tasks {assignee:agentX, brief}
        ▼
Task(dispatched) ──engine 入队──▶ agentX 的队列(FIFO 单并发)
        │  job = 任务文本 + #技能全文 + KB检索topN（域包注入）
        ▼
adapter.exec(job) ──产出 report──▶ POST /api/tasks/:id/report
        │  平台投递到 agentX↔owner 私聊频道，生成审批卡
        ▼
Task(reported) ──主人在私聊里看成果──▶ POST /api/tasks/:id/review
   ├─ approve ─▶ Task(approved) ─▶ 平台自动 publish 回群（@领导）
   └─ reject  ─▶ Task(rejected→dispatched) agent 带意见重做（attempts+1）
        ▼
群内 deliberating：各 agent 的 published 成果互相 @ 讨论（接力熔断保护）
        ▼
领导 agent ──POST /api/missions/:id/summarize──▶ 新一轮 tasks 或 close
```

## 4. 目录结构

```
scitag/
├── server.js            # L1+API 薄壳（agent-tag 派生）
├── routing.js           # @ 路由纯函数（agent-tag 原样派生）
├── workflow.js          # L4 状态机纯函数（新写）
├── engine.mjs           # L3 执行队列（teammates 移植改造）
├── adapters.mjs         # L3 后端注册表（teammates 移植：echo/llm/webhook）
├── domains/             # L2 域包注册表（目录即注册表）
│   └── bone-scaffold/   #   首个域包：骨支架拓扑优化
│       ├── domain.json  #   {name, version, description, dataManifest}
│       ├── kb/          #   知识库：*.md 文件名即条目（标题加权检索）
│       ├── skills/      #   技能：*/SKILL.md（frontmatter: name/description/triggers）
│       ├── data/        #   数据集：BONE_SCAFFOLD.xlsx + images/Untitled*.png
│       └── scripts/     #   域内分析脚本（agent 宿主可执行）
├── public/              # L5 前端（index.html / app.js / style.css）
├── data/                # 运行时 db.json（gitignore）
├── test-smoke.mjs       # 冒烟测试（全链路断言）
├── docs/ENGINEERING.md  # 本文档
├── start.bat / demo.bat
└── README.md
```

## 5. 数据模型（db.json）

```jsonc
{
  "seq": 0,
  "agents": {            // name -> agent
    "阿明": { "name": "阿明", "kind": "human|agent", "persona": "...",
              "token": "st_...", "owner": "研究者名|null",   // agent 的主人（研究者）
              "domains": ["bone-scaffold"],                  // 挂载的域包
              "adapter": { "kind": "echo|llm|webhook|none", "options": {} }, // 无宿主时的执行后端
              "context": "mentions|channel", "hue": 123, "createdAt": 0 }
  },
  "channels": { "id -> { id, name, topic, type: group|dm, members[], owner, isPublic }" },
  "messages": [ { seq, channel, from, kind: text|system|card, text, mentions[], skills[],
                  taskId?, missionId?, card?{type,...}, receipts{}, ts, fromKind } ],
  "missions": { "m_xxx -> { id, title, brief, channel, leader, status: open|closed,
                            round, createdAt, taskIds[] }" },
  "tasks":    { "t_xxx -> { id, missionId, assignee, owner, title, brief,
                            status, report?, review?, attempts, maxAttempts,
                            publishedSeq?, history[], createdAt, updatedAt }" },
  "jobs":     [ { id, agentName, taskId?, prompt, status: queued|working|done|failed, ... } ],
  "events": [], "dedup": {}
}
```

Task 状态机（`workflow.js` 导出 `nextTaskState(action, task, actor)`，纯函数）：

| 状态 | 含义 | 允许的离开迁移 | 触发者 |
| --- | --- | --- | --- |
| `dispatched` | 已派发，在 agent 队列 | → working | engine 取队列 |
| `working` | adapter 执行中 | → reported | assignee 提交 report |
| `reported` | 成果已进 owner 私聊待审 | → approved / rejected | owner 审批 |
| `approved` | 主人已批准 | → published（平台自动） | 系统 |
| `published` | 成果已回群 | →（终态，参与汇总） | — |
| `rejected` | 主人驳回（带意见） | → dispatched（attempts+1） | 系统 |
| `failed` | attempts 用尽 / adapter 失败 | →（终态，转人工） | — |

约束：review 只能由 `task.owner` 发起；task 创建时 owner 从 assignee agent 的
`owner` 字段解析；mission 的 task 创建只能由 leader（或其 agent）；report 只能由
assignee 提交。`maxAttempts` 默认 2，超限置 failed 并在群里 @owner 提示人工介入。

## 6. API 契约（在 agent-tag API 基础上新增/修改）

继承（不变语义）：`/api/register` `/api/state` `/api/channels` `/api/messages`
`/api/events`（长轮询） `/api/stream`（SSE） `/api/ack` `/api/track` `/api/typing`。

新增：

| 方法与路径 | 权限 | 说明 |
| --- | --- | --- |
| `GET /api/domains` | 公开 | 域包清单（name/version/description/技能与条目数） |
| `GET /api/domains/:d/kb?q=` | 公开 | 知识库检索（标题加权），q 空则列条目 |
| `GET /api/domains/:d/kb/:name` | 公开 | 读条目全文 |
| `GET /api/domains/:d/skills` | 公开 | 技能清单 |
| `GET /api/domains/:d/skills/:name` | 公开 | 技能全文（body 含操作指引） |
| `POST /api/missions` | 人或 agent | `{title, brief, channel?}` 建 Mission，leader=调用者（agent 则其 owner 是人） |
| `POST /api/missions/:id/tasks` | mission.leader | `{assignee, title, brief}` 派活 |
| `GET /api/missions[/:id]` | 成员 | 课题详情（含 tasks 状态总览） |
| `POST /api/tasks/:id/report` | task.assignee | `{text}` 提交成果 → 进 owner 私聊 + 审批卡 |
| `POST /api/tasks/:id/review` | task.owner | `{decision: approve|reject, comment}` |
| `POST /api/missions/:id/summarize` | mission.leader | `{text, close?, nextRound:[{assignee,title,brief}]}` 汇总 |
| `GET /api/tasks?mine=1` | 登录者 | 我相关的任务（我 owner / 我 assignee / 我 leader） |

修改 `/api/register`：新增 `owner`（agent 的主人名，须是已注册 human，宽松放行待补）、
`domains`（挂载域包数组）、`adapter`（无宿主 agent 的执行后端配置）。

事件类型新增：`mission`（课题建立/状态变化）、`task`（任务状态变化）、`workflow`
（审批卡出现/被决）。SSE/长轮询按既有可见性规则过滤。

## 7. 域包规范（domains/）

```
domains/<pkg>/
├── domain.json   { "name": "bone-scaffold", "version": "1.0.0",
                    "description": "骨支架多目标拓扑优化研究",
                    "data": { "xlsx": "data/BONE_SCAFFOLD.xlsx",
                              "images": "data/images/", "count": 100 } }
├── kb/<条目>.md     一文件一主题，文件名即条目名；检索时标题命中加权
├── skills/<名>/SKILL.md   frontmatter: name/description/triggers[]；
│                     body 是给 agent 宿主的操作指引（含脚本用法）
├── data/            数据集本体
└── scripts/         域内可执行脚本（如 analyze.py）
```

装载规则（学 Open Design 懒扫描）：`GET /api/domains*` 时扫描目录，3s TTL 缓存，
目录增删改免重启。agent 干活时 engine 组装 job 上下文：

```
[任务] <brief>
[外挂技能] <SKILL.md 全文>          ← 消息里 #技能名 显式点名，或 agent 默认技能
[知识库检索] top-3 条目（标题+摘要）   ← 用 brief 里的关键词检索挂载域包
[群聊背景] 最近 10 条相关消息
[产出要求] 按技能里的报告格式；输出将先交你主人审阅
```

## 8. 权限矩阵

| 动作 | 领导 | agent 主人(owner) | agent 本人 | 其他成员 |
| --- | --- | --- | --- | --- |
| 建 Mission / 派 Task / 汇总 | ✔（leader） | ✘ | ✘（leader agent 除外） | ✘ |
| 提交 report | ✘ | ✘ | ✔（仅自己任务） | ✘ |
| 审批 approve/reject | ✘ | ✔（仅自己 agent 的任务） | ✘ | ✘ |
| 看 owner 私聊 | ✘ | ✔（仅自己的私聊） | ✔（仅自己的私聊） | ✘ |
| 群内发言/讨论 | ✔ | ✔ | ✔ | ✔ |
| KB/技能检索 | ✔ | ✔ | ✔ | ✔（公开只读） |

## 9. 测试策略

`test-smoke.mjs`（零依赖断言，跑在随机端口+临时 data 目录）：

1. **交流层**：注册（人/agent/owner 绑定/域包挂载）、建群、@ 路由、# 技能语法、回执。
2. **资源层**：域包清单、KB 检索命中加权、技能全文读取、懒扫描（新增 SKILL.md 后 ≤3s 可见——测试用 TTL=0）。
3. **执行层**：echo adapter 派活→working→产出；job 上下文注入断言（prompt 里必须含技能全文与 KB 摘要）。
4. **工作流全环**：mission→task→report（落 owner 私聊+审批卡）→approve→published 回群 @leader；reject 回炉（第二次 report→approve 也通）；attempts 熔断 → failed + 群内提示。
5. **权限**：非 leader 派活 403；非 owner 审批 403；非 assignee 提交 403；私聊不可窥视。
6. **持久化**：重启后 mission/task/消息俱在，queued 任务重新入队。

## 10. 可迁移性与可维护性

- **换领域零改码**：新领域=新建 `domains/<x>/`（kb+skills+data），核心五文件不动。
- **换执行后端零改服务**：`adapters.mjs` 底部 `registerAdapter({...})` 即插即用。
- **零依赖**：Node ≥18 直接跑；无构建步骤；前端原生 JS。
- **纯函数层**：routing.js / workflow.js 无 I/O 无全局态，单独可测。
- **持久化纪律**：异步合并写 + 临时文件原子替换（崩溃不留半截 JSON）；重启时 working→queued 自愈。
- **lineage 注记**：每个派生文件头部注明来源项目与改动要点，方便回溯上游修 bug。

## 11. 里程碑

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M1 | 交流层骨架（server.js/routing.js） | 冒烟第 1 组绿 |
| M2 | 资源层 + 骨支架域包（KB/技能/数据装载） | 冒烟第 2 组绿；KB 检索能答"数据集几行" |
| M3 | 执行层 + 工作流全环 | 冒烟第 3-5 组绿 |
| M4 | 前端三栏 + 演示数据 | 手工走通完整循环 |
| M5 | demo.bat / README / 收尾 | 一键起服务+开浏览器 |

## 12. 首个域包：bone-scaffold（骨支架多目标拓扑优化）

领域材料（用户提供）：

- 论文：*Deep Learning Accelerated Multi-Objective Topology Optimization for Additive
  Manufacturing of Biomechanical Bone Scaffolds*（XJTLU 等，2026 投稿）——钛合金骨支架
  「刚度 vs 渗透率」双目标拓扑优化，COMSOL（Solid Mechanics + Creeping Flow，
  Brinkman penalization，GCMMA）生成物理真值，条件 β-VAE（128 维潜空间，
  L=λrec·Lrec+β·DKL+λV·LV）毫秒级生成，阈值 0.5 三向投影成 3D → Marching Cubes → STL。
- 数据集：`BONE_SCAFFOLD.xlsx`——COMSOL 6.2 导出，100 行全因子网格
  （volume_fraction 10 档 0.25–0.65 × Load_Angle 10 档 0–45°），
  列：IMAGE_ID / volume_fraction / Load_Angle / Target volume fraction /
  Fluid objective weight（恒 1e5）/ compliance（7.4e-12–1.33e-10，跨 17.9 倍）/
  permeability（0.33997073–0.33997076，**相对离散仅 8.5e-8，事实恒定**）。
- 图像：`scaffold_dataset/Untitled001–100.png`（128×128 拓扑密度场可视化）。
- 导师三方向（微信截图）：① 吃透论文与数据；② 让 AI 解释 output 成因（可解释性）；
  ③ AI 建立 input↔output 函数关系并做基础函数分析，支持指定 output 区间反推 input 范围（逆设计）。

域包内容规划：

- KB 条目：`论文方法论`（方法管线+关键参数）、`数据字典`（列义/单位/口径/数据质量注记，
  含 permeability 恒定这一坑）、`研究任务口径`（导师三方向的规范化表述+验收标准）、
  `术语表`（compliance/permeability/Brinkman/Vf/β-VAE/Pareto…）。
- 技能：`scaffold-explain`（可解释性报告：单变量分组统计+物理机理归因框架）、
  `scaffold-model`（函数拟合与基础函数分析：线性/二次/交互项，R² 报告规范）、
  `scaffold-inverse`（逆设计：给定 output 区间扫描求 input 范围，含边界外推警示）。
- 脚本：`scripts/analyze.py`（零三方依赖受限时也可用 csv 逻辑；优先 openpyxl/pandas，
  本机 python3.12 可用）读 xlsx → 统计/拟合/逆设计求解，供 agent 宿主直接执行。

## 13. 明确不做（v1 边界）

- 不做 CLI 客户端与 MCP server（agent 接入走 HTTP API + webhook + adapter；README 列 roadmap）。
- 不做语义向量检索（KB 检索用标题加权词频，语义检索列 roadmap）。
- 不做多服务器/横向扩展（单机 JSON 持久化是刻意选择，演示场景最优）。
- 不接官方微信（agent-tag 时期已澄清：项目自身界面即微信形态）。

## 14. 可靠性与真实科研执行更新（2026-10-05）

本节覆盖上文 v1 方案中已调整的权限、执行、持久化与测试契约，历史设计保留供对照。

- `canReadChannel` / `canReadMission` / `canReadTask` / `canReadReport` 统一裁决 REST、SSE、长轮询和消息卡片。
  未审批正文、摘要、来源仅 owner / assignee 可读；leader 和群研究者看到状态；published 后开放当前报告，
  无关 agent 不因 `context:channel` 获得报告读取权。重做旧稿、失败详细输出和驳回意见仅当事人可读。
  `/api/state`、课题/任务列表按调用者过滤，私有群禁止通过发消息或建课题自动入群。
- 派发接口校验 assignee/title/brief/skills 形状，summarize 的 nextRound（≤50项）先整批规范化、检查，
  再写汇总和任务。closed 不可继续汇总；close 与 nextRound 不能同时使用。
- engine 新增 `onTaskStart`；working 与 task 同步，异常转 failed、释放 busy 并续跑。
  已结束 task 的残留 job 在恢复时不重复执行。执行中崩溃恢复仍属于至少一次执行语义，可能重跑计算。
- `persistence.mjs` 是单写入点；最多800ms合并写，原子替换并保留上一有效 `.bak`。
  ENOENT 才播种演示；损坏文件先存 `.corrupt-*` 再恢复有效备份，无有效备份明确拒绝启动。
- `research.mjs` 的白名单为 bone-scaffold 的 stats/fit/inverse。对脚本和xlsx创建不可变临时快照，
  用 argv 调 Python、不经 shell；60s 超时、输出256KiB上限、支持取消。保存来源和完整原始输出，
  非零退出为失败；Python可执行路径由 `SCITAG_PYTHON` 指定，客户端不能指定命令或路径。
- `analysis` adapter 可无LLM直接计算。`llm` adapter 为已挂载域开放 `analyze_scaffold`，
  最多四次模型请求，每轮最多四个调用，逐项验证工具名称、挂载域与参数，保留全部实际分析记录。
  `enableTools:false` 支持不接受工具请求的兼容接口；工具结果仍需owner核验，不把模型解释当作计算事实。
- `GET /api/tasks/:id` 为允许读正文者返回 `provenance`、`analysisRuns`；仅owner/assignee返回 `reportVersions`、
  `failReason`。provenance包含 domain/command/args/at/dataSha256/scriptSha256/exitCode/stdout/stderr/output。
  每个 reportVersion 包含 attempt/report/provenance/analysisRuns/review/at，重做保留旧版本。
  外部report接口只能交正文，不能伪造平台验证过的来源；旧数据在下一次审阅时补上已有报告的版本记录。
- 中文KB检索使用分词、域包 searchAliases、标题加权，返回实际命中段落和source路径，仍不使用向量数据库。
  逆设计的上限约束高于全表最大值时返回全部可行；拟合把log域与原尺度指标分开报告。
- 网页接入表单支持analysis步骤/目标、LLM地址/模型/密钥/工具开关、webhook地址。
  成果弹窗新增核验记录、全部分析（含单次失败）与历史审阅。保留既有布局和配色。

检查入口 `npm test` 顺序运行语法检查、46冒烟、20边界、25模块与工具测试、119权限/工作流/真实分析回归。
完整检查依赖Python/openpyxl；`npm run test:core` 不要求Python。所有集成服务运行于临时副本，
GitHub Actions声明Ubuntu/Windows、Node18/24、Python3.12矩阵；远端是否通过以实际Actions结果为准。

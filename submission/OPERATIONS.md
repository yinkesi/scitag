# 操作方法（Run & Demo Guide）

本文档说明如何启动、演示、验证和关闭 SciTag × Adaption 这条链路。命令均为 PowerShell。

---

## 0. 前置条件

| 项 | 要求 |
| --- | --- |
| Node.js | ≥ 18（仓库零依赖，无需 `npm install`） |
| Python | 3.12（本机为 `C:\Users\LENOVO\AppData\Local\Programs\Python\Python312\python.exe`） |
| Python 包 | `torch (cu130)`, `transformers`, `peft`, `bitsandbytes`, `accelerate`, `adaption` |
| 模型权重 | `D:\code\_adaption\models\Qwen3.5-4B-merged-v1strong\`（已合并 LoRA，独立可用） |
| 端口 | 8780（模型）、8790（SciTag demo）；若被占用见 §7 |

> `ADAPTION_API_KEY` 只在训练/下载时用；**演示不需要联网**，密钥不要写进仓库。

---

## 1. 一键启动（桌面的 SciTag 快捷方式）

双击桌面 **SciTag** 图标：

- 如果 8790 或 8093 已在监听 → 直接打开浏览器；
- 否则在 8093 起 `node server.js` 并打开浏览器。

> 快捷方式只负责 **SciTag 本体**；要演示“AI agent 回答病例”，还需要模型服务（§2）。

---

## 2. 启动模型服务（8780）

```powershell
cd D:\code\_adaption\dataset
$env:MODEL_DIR='D:\code\_adaption\models\Qwen3.5-4B-merged-v1strong'
$env:ADAPTER_DIR='D:\code\_adaption\models\__none__'   # 已合并，不再加载 adapter
$env:PORT='8780'
python serve_adapted.py
```

看到 `ready; cuda= True 4bit= True` 和 `serving on http://127.0.0.1:8780/v1` 即可。
首次加载约 15–20 秒；显存占用约 3.2 GB。

**验证：**

```powershell
curl.exe -s http://127.0.0.1:8780/health
# {"ok": true, "cuda": true, "model": "scitag-stent-adapted"}
```

---

## 3. 启动 SciTag（8790，demo）

```powershell
cd D:\code\scitag
$env:SCITAG_PORT='8790'
node server.js
```

浏览器打开 `http://127.0.0.1:8790`，进入「骨支架课题组」频道。

> demo 账号 token：`demo-jiaoshou` / `demo-wangyan` / `demo-liyan`。
> 数据在 `D:\code\scitag\data\db.json`（本地 demo 状态）。

---

## 4. 注册 AI agent（只需一次）

```powershell
cd D:\code\_adaption
node register_stent_agent.mjs http://127.0.0.1:8790 demo-wangyan
```

输出 `registered 支架适配模型` 即成功；token 存在 `D:\code\_adaption\scitag-agent.json`。
该 agent 的配置：`domains=['vascular-stent']`，adapter `llm` →
`{baseUrl:'http://127.0.0.1:8780/v1', model:'scitag-stent-adapted', enableTools:true, forceToolCommands:['concept','fdo'], maxTokens:1024, timeoutMs:420000}`。
`concept` 出概念/密封力，`fdo` 出材料物理指标（t_crit / 质量损失 / 孔径漂移 / 释放指数）。

---

## 5. 演示一个病例

**方式 A：在网页里输入**（适合录屏/现场演示）

进入「骨支架课题组」，发送：

```
@支架适配模型 病例：肝动脉右支供血，病变/缺损直径 4.0 mm，目标血管 3.0 mm，病变长度 10 mm，血压 100 mmHg，术式意向：断流栓塞；设计扫描给出释放 7 天、服役 90 天、孔口 0.71 mm。请做概念筛选，并输出材料物理指标。
```

约 60–120 秒后收到回复。重点看四点：

1. **A 载药**：约 270 µg、1.39×10⁻⁵ 口服剂量 → 不成立；
2. **B 封堵**：静压载荷 167 mN → 密封力 **0.335 N**（安全系数 2）；
3. **材料短名单**：Fe / Zn / Mg 通过永久闭塞的 1.5× 力裕度筛选；
4. **FDO 材料物理指标**：每种聚合物的 `t_crit`、90 天质量损失、90 天孔径漂移、释放指数 n、孔口/零级判定（常数是文献量级占位，口径必须说“screening, not measured”）。

**方式 B：命令行一键跑**

```powershell
cd D:\code\_adaption
node scitag_case_run.mjs http://127.0.0.1:8790
```

---

## 6. 审计与验证（“数字是不是编的”）

每次群聊回复会写一条 job 记录，包含 `analysisRuns` 与 `provenance`：

```powershell
python -c "import json;d=json.load(open(r'D:\code\scitag\data\db.json',encoding='utf-8'));j=[x for x in d['jobs'] if x.get('agentName')=='支架适配模型'][-1];print(j['id'],j['status'],len(j.get('analysisRuns') or []));print(j.get('provenance'))"
```

期望：`... done 1`，provenance 里 `domain=vascular-stent`、`command=concept`、`exitCode=0`，
`dataSha256` / `scriptSha256` 为 64 位十六进制。

**直接验证工具本身：**

```powershell
python D:\code\scitag\domains\vascular-stent\scripts\stent_tool.py concept --lesion-mm 4 --vessel-mm 3 --length-mm 10 --pressure-mmhg 100 --json
```

**跑全量测试：**

```powershell
cd D:\code\scitag
npm test          # 期望 exit 0；含回归 119 条 + 新 test-llm-tools
```

---

## 7. 关闭与重启

```powershell
# 关模型服务
Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'serve_adapted' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# 关 SciTag
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'scitag' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

重启电脑后按 §2 → §3 顺序再起即可（agent 配置持久化在 `db.json`，不用重注册）。

---

## 8. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `llm 调用失败：fetch failed` | 8780 没起或还在加载；等 health 返回 ok 再试 |
| `CUDA out of memory` | 显卡同时开了别的模型/游戏；关掉后重启模型服务。长上下文已改为精简 tool round，正常病例不会 OOM |
| 回复只说“我将调用工具”但没有数字 | 说明 forceToolCommand 没生效；检查 `db.json` 里 agent 的 `adapter.options.forceToolCommand` 是否为 `concept` |
| 回复是空/超时 | 4B 生成较慢（~5 tok/s），等 60 s；或在页面重发 |
| 端口被占用 | 改 `$env:PORT` / `$env:SCITAG_PORT`，并同步改 agent 的 `baseUrl` |
| `no module named adaption` | 只需训练时安装：`pip install adaption` |
| 中文乱码 | 终端切 UTF-8：`chcp 65001`；不影响网页 |

---

## 9. 重新生成提交材料

```powershell
cd D:\code\scitag\submission
python make_figures.py       # 图：figure-winrate.png / figure-pipeline.png
python make_onepager.py      # 一页纸：one-pager.pdf（Edge headless 打印）
```

演讲稿见 [SPEECH.md](SPEECH.md)：按稿自己录 4 分钟视频（≤4:00，不允许加速），上传后把链接填进提交表。

---

## 10. 数据与合规（重要）

- **MatWeb 原始 CSV 不上传、不再分发**（仅内部研究参考）；仓库只含派生材料行与引用。
- Adaption 训练数据为模板/公式生成，不含患者隐私。
- 本系统输出是**概念级筛选**，不构成临床决策；适应证、器械尺寸、术式必须由医生确定。
- 不把 `ADAPTION_API_KEY`、`db.json` 里的 token 提交到公开仓库。

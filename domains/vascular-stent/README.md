# vascular-stent 域包（可吸收血管介入器件）

SciTag 的第二个域包：把「可吸收血管支架物理模型与计算验证」+ 材料库变成 agent 可直接使用的外挂知识库 + 技能 + 数据 + 工具，并扩展到**面向病例输入的介入概念筛选**（药物涂层支架 vs 封堵/栓塞器件）。**零改平台代码**（复制目录即注册，`domains/` 懒扫描）。

## 目录

```
vascular-stent/
├── domain.json                         # 域清单：name/description/searchAliases/data/analysis
├── kb/                                 # 知识库：文件名即条目名，7 条
│   ├── 模型迁移边界与基线参数.md
│   ├── 器械性能与血流指标.md
│   ├── 材料数据字典.md
│   ├── 计算验证与验收口径.md
│   ├── 药物涂层支架剂量边界.md          # 涂层载药量 vs 口服日剂量（概念 A 的否决依据）
│   ├── 封堵覆膜器件与病例输入.md        # 覆膜支架/封堵器 + 医生输入口径（概念 B）
│   └── 术语表.md
├── skills/                             # 技能：frontmatter(name/description/triggers)
│   ├── stent-material-select/SKILL.md  # 材料筛选与对比
│   ├── stent-validation/SKILL.md       # V0–V5 计算验证报告
│   └── vascular-concept-screen/SKILL.md# 病例输入 → 概念筛选 → 材料短名单
├── data/
│   ├── MatWeb材料汇总_2026-10-18.csv    # 9 个材料 × 18 列
│   └── MatWeb属性明细_2026-10-18.csv    # 65 条属性（单值/区间/下限）
├── scripts/
│   ├── stent_tool.py                   # 零依赖 CLI：materials/ring/flow/concept/verify/all
│   └── original_vascular_stent_validation.py  # 用户原始脚本（numpy+PIL，留档复现用）
└── docs/
    └── 模型原文提取.md                  # docx 全文提取（表格/公式/参考文献）
```

## 概念筛选（病例输入 → 材料建议）

医生输入肿瘤/病变位置、病变/缺损尺寸、目标血管直径与长度、血压/流量 → 系统做概念级物理筛选，给材料短名单与数据缺口（不做影像诊断）：

```bash
python3 domains/vascular-stent/scripts/stent_tool.py concept \
  --location "肝动脉右支供血" --lesion-mm 4 --vessel-mm 3 --length-mm 10 --json
```

默认病例（4 mm 缺损、100 mmHg、3 mm 血管）的示例结论：

- **A 载药**：1.5 cm²×5 µm 涂层约载药 150–270 µg，仅等效口服他汀 20 mg/day 的 **11 分钟**；18 个月平均释放为口服日剂量的 **1.4×10⁻⁵** → 系统性慢病不成立，局部 DES 逻辑成立但属既有临床。
- **B 封堵**：4 mm 缺损静压载荷 **167 mN**，安全系数 2 需 **335 mN** 密封力；连续环近似下 PLLA/PLGA 力裕度约 1.7–2.0，PDO 仅 0.39（需更厚/加强框架），金属无腐蚀动力学。B 还要先区分「封堵但保通畅（覆膜支架）」与「断流栓塞（封堵器）」。

## 数据来源与口径

| 资料 | 来源 | 日期 | 用途 |
| --- | --- | --- | --- |
| 物理模型 docx | 用户提供《可吸收血管支架物理模型与计算验证》V1.0 | 2026-10-18 | KB 的模型/验证口径 |
| MatWeb 材料表 | MatWeb（原始 URL 见 CSV `原始URL` 列） | 访问 2026-10-18 | 材料选型数据 |
| 计算验证脚本 | 用户提供 `血管支架计算验证.py` | 2026-10-18 | 数值验证基准（可复跑） |

**重要边界**：docx 里的几何/载荷/材料参数是「可替换的计算基线」，不是产品规格或临床结论；MatWeb 只有基础物性，金属无腐蚀动力学、聚合物只有近似完全吸收时间。使用这些数据时必须带上来源与不确定性（见 KB「材料数据字典」「计算验证与验收口径」）。

## 工具

```bash
python3 domains/vascular-stent/scripts/stent_tool.py materials --family polymer
python3 domains/vascular-stent/scripts/stent_tool.py ring --E 44.2 --t 120
python3 domains/vascular-stent/scripts/stent_tool.py flow --q 100
python3 domains/vascular-stent/scripts/stent_tool.py verify --json
python3 domains/vascular-stent/scripts/stent_tool.py all --json
```

工具只依赖 Python 标准库（无 numpy/PIL），输出可写进成果 provenance。`original_vascular_stent_validation.py` 需要 numpy+PIL，仅用于复现原始图表与 CSV。

## 平台接线（2026-10-20 起已原生支持）

本域包在 `domain.json` 的 `analysis` 块里声明了可执行工具，平台（`research.mjs` + `analysis-spec.mjs`）按声明执行，
不再有 bone-scaffold 白名单：

- `analysis` 后端：`adapter.options = {domain:"vascular-stent", command:"materials", params:{family:"polymer"}}`；
- `llm` 后端：挂载本域包时自动注册工具 `run_stent_tool`，模型可调用
  `materials / ring / flow / verify / all`，参数逐项校验（数值/枚举/必填）；
- 平台对脚本与两个 CSV 做快照并记录 SHA256，成果带 provenance。

## 已知限制

1. 外部 agent（`adapter.kind: none`，走 worker 长轮询）仍只拿到 KB 片段与技能正文，**不注入 CSV 本体**；
   本机工作目录需能看到域包才能直接跑 `stent_tool.py`。技能里已写"缺数据标未取得、禁止编造"。数据/脚本下发是下一步（P0）。
2. 任务 prompt 的 KB 注入是每域 top3、每条 ≤600 字符；本域有 5 条 KB，被挤掉的条目需要 agent 自行 `GET /api/domains/:d/kb/:name` 补全文。
3. MatWeb 数据仅限本项目内部研究参考，再分发/公开引用须遵守 MatWeb 使用条款并给原始 URL。
4. 当前没有真实支架几何、材料塑性/降解参数、台架与体内数据——本域包只能支撑方法级与数值实现级的任务。

## 验证

- 平台测试：`node --test test-vascular-stent.mjs`（工具注册/analysis 后端/参数校验），
  `node --test test-research.mjs`（真实执行与 provenance），`npm test`（全量）。
- 工具数值与原脚本 numpy 实跑的逐项对照见 `stent-domain/_work/tool-check/compare.md`（工作区留档，不入库）。`getAdapter('analysis')` 也可直接调用：`exec(job, {domain:'vascular-stent', command:'verify'})`。

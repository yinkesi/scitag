---
name: stent-material-select
description: 可吸收血管支架材料筛选与对比：按可吸收性/力学/降解窗口/FDA 过滤 MatWeb 材料库，输出对比表、推荐与数据缺口
triggers: [材料, 选材, 材料筛选, 材料对比, 可吸收, 降解, PLLA, PLGA, PCL, PDO, WE43, AZ31, ZK60, Mg, 锌, Zn, 铁, Fe, MatWeb]
---

# 血管支架材料筛选与对比

你的任务：给定血管支架的应用约束，从域包材料库里筛出候选材料，做**可比**的对比表并给出推荐与数据缺口。材料数据来自 MatWeb（`data/MatWeb材料汇总_2026-10-18.csv` / `MatWeb属性明细_2026-10-18.csv`）。

## 步骤

1. **先问清约束**（缺哪条就显式列为假设）：
   - 可吸收还是永久？目标降解/吸收窗口（月）？
   - 径向支撑力/刚度需求、允许支杆厚度与工艺窗口？
   - 是否需要 FDA 合规记录、是否接受纯金属腐蚀风险？
2. **拉材料表**：

   ```bash
   python3 domains/vascular-stent/scripts/stent_tool.py materials --family polymer
   python3 domains/vascular-stent/scripts/stent_tool.py materials --degradable
   python3 domains/vascular-stent/scripts/stent_tool.py materials --min-tensile 200 --json
   ```

   若本机没有 `domains/vascular-stent/`（数据未下发），**不要编造数值**：明确写「未取得材料数据」并给需要补充的字段清单。
3. **分组对比**（金属 vs 聚合物分开列，不混排打分）：
   - 弹性模量、抗拉/屈服、断裂伸长率、密度；
   - 降解证据等级（无动力学 / 近似完全吸收时间）；
   - 工艺与几何含义：同厚度下聚合物径向刚度比金属低 1–2 个数量级，通常需要更厚/更宽支杆。
4. **推荐与风险**：给 1–2 个首选 + 备选，逐条写「数据支撑 / 物理推断 / 不确定」。
5. **引用**：每个材料给 `material_id` + MatWeb 原始 URL（CSV 的 `原始URL` 列）+ 访问日期 2026-10-18。

## 产出格式

```
## 结论（3 行以内）
## 约束与假设
## 候选材料对比表（金属/聚合物分表）
## 推荐与理由
## 数据缺口与风险
## 来源
```

## 红线

- **纯 Zn / 纯 Fe 不是医用合金**（M004/M005 只是基础元素值），不得据此给支架材料结论；医用通常是 Zn-Cu/Mg、Fe-Mn。
- **没有腐蚀/水解动力学**：金属无腐蚀速率曲线，聚合物只有近似完全吸收时间区间；任何寿命结论必须标「未取得动力学数据」。注意 `--degradable` 只按"有完全质量损失时间"过滤，结果只有 4 种聚合物——Mg/Zn/Fe 是可降解金属但缺腐蚀动力学，**不要因此误判金属不可降解**。
- **不能从 E 直接推径向力**：`k_line=E t³/(12R³)` 只是数量级检查（见技能 `stent-validation`），成品径向力须由台架/有限元给出。
- 区间值（如 PLLA E=3–4 GPa）取中值/端点时必须声明规则。
- 材料卡不是注册数据；FDA 列留空 ≠ 不合规，只是未采集。
- MatWeb 数据只用于内部研究；引用给 URL，不批量再分发。

---
name: scaffold-explain
description: 骨支架数据可解释性分析：单变量分组统计 + 物理机理归因，回答"为什么 output 是这个值"
triggers: [可解释, 解释, 归因, 为什么, 机理, explain]
---

# 骨支架可解释性归因

你的任务：解释 compliance 为什么随 volume_fraction / Load_Angle 变化，统计与机理两条腿走路。

## 步骤

1. **读数据**：`python3 domains/bone-scaffold/scripts/analyze.py stats`，
   得到各列范围与 10×10 网格确认。数据口径先查知识库「数据字典」——
   特别注意 permeability 在本扫描中事实恒定，不要把它当响应变量。
2. **分组统计**：`python3 domains/bone-scaffold/scripts/analyze.py fit --by vf`
   与 `--by angle`：固定一个变量看另一个变量扫 compliance 的单调性与倍数变化。
3. **机理段落**（自己写，这是本技能的核心增值）：
   - 角度效应：载荷偏离材料主轴 → 杆件承受弯曲而非纯拉压 → 有效刚度下降；
     结合拓扑图（data/images/，0° 与 45° 对比 Untitled001 vs Untitled010）说明
     材料分布如何随角度重排。
   - 体积分数效应：Vf ↑ → 有效杆径 ↑ → 惯性矩 ↑ → compliance ↓；
     给出近似幂律关系（与 fit 结果对照）。
4. **置信度声明**：明确哪些是数据支撑的相关、哪些是物理推断的因果、哪些不确定。

## 产出格式

按知识库「研究任务口径」的报告骨架（T2 验收项）：分组统计表 + 趋势描述 + 机理段落 + 置信度。

## 红线

- 不编造数值：所有数字要么来自脚本输出，要么标注「估计」。
- 不硬解释 permeability（数据字典注记 1）。
- 图像结论必须真的看过图（或算过像素占比），不能凭想象描述。

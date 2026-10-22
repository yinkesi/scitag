# FDO 材料物理指标筛选口径

## 结论先行

`stent_tool.py fdo` 把 FDO 数据集（2026-10-21）的聚合物降解模型接进域包：输入**释放窗口 / 服役期 / 孔口直径**，输出每种聚合物的**时间相关物理指标**——`t_crit`、释放末与服役末的质量损失、孔口半径漂移、Korsmeyer–Peppas 释放指数 `n`、burst，以及「孔口容差 / 零级释放」双约束判定。

**这些动力学常数是文献量级占位（literature-order placeholders），不是拟合值。** 演示口径必须写「screening, not measured」，不能当寿命或临床结论。

## 命令与参数

```bash
python3 domains/vascular-stent/scripts/stent_tool.py fdo \
  --release-days 7 --horizon-days 90 --orifice-mm 0.71 --json
```

| 参数 | 含义 | 典型值 |
| --- | --- | --- |
| `--release-days` | 药物释放窗口（天） | 7 |
| `--horizon-days` | 器件服役期（天） | 90 |
| `--orifice-mm` | 孔口直径（mm），内部按半径 r0=直径/2 | 0.71（FDO 设计扫描） |
| `--tolerance` | 孔口半径容差（默认 0.10 = ±10%） | 0.10 |

## 输出指标怎么读

| 指标 | 物理含义 | 判据 |
| --- | --- | --- |
| `t_crit_days` | 分子量降到临界值（bulk）或表面侵蚀时间常数（surface） | 越短越早失去力学完整性 |
| `mass_loss_at_release_end` | 释放末质量损失（0=完好，1=消失） | 释放期内不能塌 |
| `mass_loss_at_horizon` | 服役末质量损失 | 与孔口漂移耦合 |
| `radius_drift_at_*` | 孔口半径相对漂移 | 服役末 \|dr\| ≤ 10% 才算孔口 OK |
| `release_order_n` | 释放指数 n：~0.45 Fickian，~1 零级 | n ≥ 0.85 才算零级 |
| `burst_fraction` | 24 h 突释比例 | 需求单常要求 ≤15% |

## 已知结论（FDO 数据集的真实结论，不是本域包新增）

- bulk 侵蚀（PLGA/PCL）：早期几何稳、后期塌 → 孔口 OK，但释放是一级（n≈0.45）。
- surface 侵蚀（POE/聚酸酐）：n≈1 零级，但孔口随表面后退而扩大，两个误差叠加 → 孔口 FAILS。
- 因此「7 天零级 + 90 天孔口 ±10%」这组需求**本身过约束**；出路：拆功能（不降解孔口 + 独立降解药库）、放宽零级、缩短服役期。

## 红线

- 不得把 `t_crit` / 质量损失当作实测降解寿命；常数未拟合。
- 模型不含 pH、血栓、疲劳、灭菌、几何非理想性；必须台架 + 动物验证。
- 孔口漂移用「平板内孔 + 1.5 倍外径」近似；真实器件要做径向/泄漏台架。
- 输出是材料筛选与物理指标，不构成器械尺寸或临床决策。

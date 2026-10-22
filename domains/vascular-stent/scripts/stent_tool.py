#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""stent_tool.py —— 可吸收血管支架（vascular-stent）域包零依赖数值工具

本脚本是 SciTag 域包 `domains/vascular-stent/scripts/` 下的工具
（本工作区对应路径 `_scitag_rag_probe/stent-domain/vascular-stent/scripts/`），供 agent 宿主直接调用，
用于把「材料表 + 解析基准 + 数值实现自检 + 薄环刚度尺度」做成可复算的 CLI。

用法（任意工作目录均可；数据路径按脚本自身位置解析）：
  python stent_tool.py materials [--family Mg|Zn|Fe|polymer] [--degradable]
                                [--min-tensile 60] [--sort E|tensile|name] [--asc] [--json]
  python stent_tool.py ring  --E 44.2 --t 120 [--R 1.5] [--displacement 0.1 0.2] [--json]
  python stent_tool.py flow  [--q 100] [--R 1.5] [--L 18] [--rho 1025] [--mu 1.5e-3] [--json]
  python stent_tool.py verify [--n 20,40,80,160,320] [--pipe] [--cylinder] [--json]
  python stent_tool.py all   [--json]

公式（与 docx 正文 §8.1/§8.2、表 6 及原脚本 `血管支架计算验证.py` 完全同口径）：

  1) 圆管泊肃叶基准（稳态牛顿流体）：
       v_mean = Q / (π R²)               平均流速
       Re     = ρ v_mean (2R) / μ        水力直径取 2R
       Δp     = 8 μ L Q / (π R⁴)         压降
       τ_w    = 4 μ Q / (π R³)           壁面剪切应力 WSS
       u_max  = 2 v_mean                 中心线流速（解析抛物线解 u(r)=Δp(R²-r²)/(4μL)）
     基线算例：R=1.5 mm、L=18 mm、ρ=1025 kg/m³、μ=1.5 mPa·s、Q=100 mL/min
     → v=0.235785 m/s、Re=483.359、Δp=22.635 Pa、τ_w=0.943140 Pa、u_max=0.471570 m/s。

  2) 圆管有限差分（代码验证，复刻原脚本 pipe_fd）：
       内部节点：(u[i-1] - 2u[i] + u[i+1])/h² + (u[i+1]-u[i-1])/(2 h r_i) = dp/dx / μ
       r=0 轴心用 L'Hôpital 极限：-4u[0]/h² + 4u[1]/h² = (dp/dx)/μ
       壁面 no-slip：u[n] = 0
       壁面 WSS 用三点单侧三阶差分：u'(R) ≈ (3u[n] - 4u[n-1] + u[n-2])/(2h)，τ_w = -μ u'(R)
       误差：‖u_fd - u_exact‖₂ / ‖u_exact‖₂

  3) 轴对称厚壁圆筒有限元（代码验证，复刻原脚本 axisymmetric_cylinder_fem）：
       2 节点线单元，径向位移 u(r) 为唯一自由度；几何矩阵
         B = [[-1/h, 1/h], [N₁/r, N₂/r]]（轴向应变取 0，环向应变 = u/r）
       平面应变弹性矩阵 C = [[λ+2μ, λ], [λ, λ+2μ]]，λ = Eν/((1+ν)(1-2ν))，μ = E/(2(1+ν))
       单元刚度 K_e = ∫ 2πr · Bᵀ C B dr，3 点 Gauss（±√(3/5), 0；权 5/9, 8/9, 5/9）
       内压以等效节点力加载：F₀ = 2π a p
       解析解（Lamé，平面应变）：u(r) = p a²/(E(b²-a²)) · [(1+ν)(1-2ν) r + (1+ν) b²/r]
       内壁环向应力解析：σθ(a) = p (b²+a²)/(b²-a²)
       基准：a=1.5 mm、b=2.0 mm、E=1 MPa、ν=0.45、p=13332.2 Pa（≈100 mmHg）
       网格收敛目标（docx 表 6，N=20/320）：
         位移相对 L2 误差 1.846e-4 / 7.210e-7；内壁环向应力相对误差 3.402% / 0.217%

  4) 连续薄环刚度尺度（docx 式 19）：
       k_line = E t³ / (12 R³)            [N/m²]
       F(ΔR) = k_line · ΔR · 1 mm         [N，每 1 mm 轴向长度]
     R=1.5 mm 时：WE43 t=120 μm → k_line=1.8859e6 N/m²、ΔR=0.1 mm → 0.1886 N/mm；
     PLLA t=180 μm → 0.0504 N/mm；PLGA t=180 μm → 0.0432 N/mm。

与原脚本的关系：
  - `flow` / `ring` / `verify` 的常数与公式逐行对齐 `血管支架计算验证.py`（含其 build() 中的
    参考几何、Q 窗口、环材料表）；`verify` 的参考值由该脚本在带 numpy 的 Python 实跑得到
    （_work/tool-check/orig-run/ 下的 summary.json）。
  - 唯一实现差异：原脚本用 numpy.linalg.solve（一般 LU），本脚本用纯 Python Thomas 三对角
    求解器（两个算例的矩阵都是三对角）。两者都是直接法，物理量一致到 ~1e-13 相对；
    但 ‖误差‖₂/‖精确解‖₂ 这类「两个几乎相等的数相减」的比值会放大求解器 roundoff，
    N 越大放大越明显（N=320 处约 1e-4 相对），见 verify 的 checks 与 compare.md。
  - 绘图（PIL/numpy 版）未移植：域包工具只输出数值与 JSON，图片交给宿主。

依赖：仅 Python 标准库（argparse/csv/json/math/unicodedata/hashlib/pathlib），Python ≥ 3.8。
不 import numpy / PIL / pandas —— 没有第三方包的机器上也能跑。

红线（必须保留）：
  * 这些是「数值实现自检 + 数量级尺度检查」，不是临床验证，也不构成任何有效性/安全性结论。
  * 连续薄环不是成品支架径向力模型（开孔单元、桥筋、摩擦、接触会显著改变有效刚度）；
    成品径向力必须由台架（压握-扩张、径向力-位移曲线）校准。
  * 泊肃叶/有限差分基准是稳态牛顿流体直管，不是患者血流阈值；WSS 判据不可外推。
  * 厚壁圆筒只是结构实现的验证算例，不是真实血管或支架的应力预测。
  * Mg/Zn/Fe 与 PLLA/PLGA 的材料数据来自 MatWeb 基础物性，不含腐蚀/水解动力学、
    疲劳、血液相容性与体内数据；本工具不给出寿命或降解预测。
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

# --------------------------------------------------------------------------
# 路径与常量
# --------------------------------------------------------------------------

HERE = Path(__file__).resolve().parent
PKG_DIR = HERE.parent                       # .../vascular-stent
DATA_DIR = PKG_DIR / "data"                 # 数据按脚本位置解析，不依赖 cwd

VERSION = "1.0.0"

# 参考几何/流体（docx §8.1；原脚本 build() 同值）
R_MM_DEFAULT = 1.5
L_MM_DEFAULT = 18.0
RHO_DEFAULT = 1025.0          # kg/m³
MU_DEFAULT = 1.5e-3           # Pa·s
Q_BASELINE_ML_MIN = 100.0     # docx 基线流量
FLOW_WINDOW_ML_MIN = (20.0, 40.0, 60.0, 80.0, 100.0, 120.0, 150.0, 200.0)
VERIFY_N_DEFAULT = (20, 40, 80, 160, 320)

# 轴对称厚壁圆筒基准（原脚本 axisymmetric_cylinder_fem 调用参数）
CYL_RI_M = 1.5e-3
CYL_RO_M = 2.0e-3
CYL_E_PA = 1.0e6
CYL_NU = 0.45
CYL_PRESSURE_PA = 13332.2     # ≈100 mmHg

# 薄环尺度检查材料（原脚本 StentMaterial 表；E 取 MatWeb 区间中点）
RING_CASES = (
    {"material": "WE43 Mg", "family": "Mg", "E_gPa": 44.2, "t_um": 120.0,
     "note": "MatWeb 弹性模量单值（data/MatWeb材料汇总 M001）"},
    {"material": "PLLA", "family": "polymer", "E_gPa": 3.5, "t_um": 180.0,
     "note": "MatWeb 弹性模量 3.00-4.00 GPa 区间中点（P001）"},
    {"material": "PLGA 85/15", "family": "polymer", "E_gPa": 3.0, "t_um": 180.0,
     "note": "MatWeb 弹性模量 2.00-4.00 GPa 区间中点（P002）"},
)
RING_DISPLACEMENTS_MM = (0.1, 0.2)

# 参考值：由原脚本（numpy 版）实跑得到，见 _work/tool-check/orig-run/
#   stent_model_validation_artifacts/stent_model_validation_summary.json
FLOW_REF = {
    "mean_velocity_m_s": 0.23578510087688195,
    "Re": 483.35945679760795,
    "pressure_drop_pa": 22.635369684180667,
    "wss_pa": 0.9431404035075278,
    "centerline_velocity_m_s": 0.4715702017537639,   # 解析 2·v_mean
}
PIPE_REF = {
    "centerline_velocity_m_s": 0.4715702017537639,
    "wss_pa": 0.9431404035075278,
    "l2_abs_max": 1.0e-10,      # docx V0 判据：流速误差 ≤1e-10
}
CYL_REF = {
    20: {
        "rel_L2_displacement_error": 1.8457726946971898e-04,
        "inner_displacement_fem_m": 6.999515383258606e-05,
        "inner_displacement_exact_m": 7.000833450000002e-05,
        "inner_hoop_stress_fem_pa": 49234.63373202224,
        "inner_hoop_stress_exact_pa": 47615.0,
        "hoop_stress_relative_error": 0.034015199664438465,
    },
    320: {
        "rel_L2_displacement_error": 7.210360503108495e-07,
        "inner_displacement_fem_m": 7.000828299792517e-05,
        "inner_displacement_exact_m": 7.000833450000002e-05,
        "inner_hoop_stress_fem_pa": 47718.35029583956,
        "inner_hoop_stress_exact_pa": 47615.0,
        "hoop_stress_relative_error": 0.0021705407085910325,
    },
}
RING_REF = {
    "WE43 Mg": {
        "k_line_N_m2": 1885866.666666666,
        "force_at_0p1mm_N_per_mm": 0.18858666666666662,
        "force_at_0p2mm_N_per_mm": 0.37717333333333325,
    },
    "PLLA": {
        "k_line_N_m2": 503999.99999999994,
        "force_at_0p1mm_N_per_mm": 0.0504,
        "force_at_0p2mm_N_per_mm": 0.1008,
    },
    "PLGA 85/15": {
        "k_line_N_m2": 431999.9999999999,
        "force_at_0p1mm_N_per_mm": 0.04319999999999999,
        "force_at_0p2mm_N_per_mm": 0.08639999999999998,
    },
}

LIMITATIONS = (
    "连续薄环只是刚度尺度检查，不是点阵支架仿真，也不是成品支架径向力（开孔/桥筋/摩擦/接触会显著改变有效刚度）",
    "flow 是稳态牛顿流体直管基准；Re≈483 说明处于层流，但 WSS 数值不是患者阈值",
    "轴对称厚壁圆筒只是结构实现的验证算例，不是真实血管/支架的应力预测",
    "材料数据仅 MatWeb 基础物性；Mg/Zn/Fe 无腐蚀动力学、聚合物无逐时点水解曲线，本工具不做降解/寿命预测",
    "verify 的 checks 只证明「公式与实现自洽」，不构成临床或监管意义上的验证",
    "不提供疲劳、接触、脉动流、血液相容性结论",
)

# 数据文件名（ASCII 文件名用 glob 回退，容忍改名/前缀变化）
SUMMARY_CSV_NAME = "MatWeb材料汇总_2026-10-18.csv"
DETAIL_CSV_NAME = "MatWeb属性明细_2026-10-18.csv"

# 明细表里的属性名 → 统一键
DETAIL_KEYS = {
    "密度": "density",
    "抗拉强度": "tensile",
    "断裂抗拉强度": "tensile",
    "屈服强度": "yield",
    "断裂伸长率": "elongation",
    "弹性模量": "modulus",
    "熔点": "melting",
    "固相线": "solidus",
    "液相线": "liquidus",
    "玻璃化转变温度": "tg",
    "完全质量损失时间": "mass_loss",
}


# --------------------------------------------------------------------------
# 基础设施
# --------------------------------------------------------------------------

def _fatal(message, code=2):
    """参数/文件错误：写 stderr 并以非零码退出。"""
    sys.stderr.write("错误：{}\n".format(message))
    sys.exit(code)


def _setup_stdout():
    """统一 stdout/stderr 为 UTF-8，保证 --json 输出可被平台按 UTF-8 解析。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:  # 旧环境/已被重定向为不可配置的流
            pass


def _num(value, sig=6):
    """数值格式化：None → '-'，绝对值过小/过大用科学计数法。"""
    if value is None:
        return "-"
    value = float(value)
    if value == 0.0:
        return "0"
    if abs(value) < 1.0e-2 or abs(value) >= 1.0e6:
        return "{:.{}e}".format(value, sig - 1)
    return "{:.{}g}".format(value, sig)


def _pct(value, sig=4):
    """小数 → 百分数字符串。"""
    if value is None:
        return "-"
    return "{}%".format("{:.{}g}".format(float(value) * 100.0, sig))


def _disp_width(text):
    """终端显示宽度（CJK 全角按 2 计），用于对齐简单表格。"""
    width = 0
    for ch in text:
        width += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return width


def _pad(text, width, align):
    gap = max(0, width - _disp_width(text))
    if align == "r":
        return " " * gap + text
    if align == "c":
        left = gap // 2
        return " " * left + text + " " * (gap - left)
    return text + " " * gap


def render_table(headers, rows, aligns=None):
    """渲染纯文本表格，返回字符串列表（不打印）。"""
    if aligns is None:
        aligns = ["l"] * len(headers)
    widths = []
    for index, header in enumerate(headers):
        widths.append(max([_disp_width(header)] + [_disp_width(str(row[index])) for row in rows]))
    lines = [
        "  ".join(_pad(header, widths[i], aligns[i]) for i, header in enumerate(headers)),
        "-+-".join("-" * width for width in widths),
    ]
    for row in rows:
        lines.append("  ".join(_pad(str(cell), widths[i], aligns[i]) for i, cell in enumerate(row)))
    return lines


def _print_table(headers, rows, aligns=None):
    for line in render_table(headers, rows, aligns):
        print(line)


def _sha256_of(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _file_provenance(path):
    """数据文件 provenance；路径尽量用包内相对路径，便于跨机器复核。"""
    try:
        shown = str(path.relative_to(PKG_DIR))
    except ValueError:
        shown = str(path)
    if not path.exists():
        return {"path": shown, "exists": False}
    return {
        "path": shown,
        "exists": True,
        "bytes": path.stat().st_size,
        "sha256": _sha256_of(path),
    }


# --------------------------------------------------------------------------
# 纯 Python 数值内核
# --------------------------------------------------------------------------

def thomas_solve(lower, diag, upper, rhs):
    """三对角方程组直接解（Thomas 算法，无主元）。

    lower[0] 与 upper[-1] 不使用；长度为 n。返回长度 n 的解向量。
    两个验证算例的系数矩阵都是三对角且对角占优，无需选主元。
    """
    n = len(diag)
    if n == 0:
        raise ValueError("空方程组")
    if not (len(lower) == len(upper) == len(rhs) == n):
        raise ValueError("三对角数组长度不一致")
    c_prime = [0.0] * n
    d_prime = [0.0] * n
    pivot = diag[0]
    if pivot == 0.0:
        raise ValueError("三对角矩阵主元为 0")
    c_prime[0] = upper[0] / pivot
    d_prime[0] = rhs[0] / pivot
    for i in range(1, n):
        pivot = diag[i] - lower[i] * c_prime[i - 1]
        if pivot == 0.0:
            raise ValueError("三对角矩阵主元为 0（第 {} 个方程）".format(i))
        c_prime[i] = upper[i] / pivot if i < n - 1 else 0.0
        d_prime[i] = (rhs[i] - lower[i] * d_prime[i - 1]) / pivot
    solution = [0.0] * n
    solution[-1] = d_prime[-1]
    for i in range(n - 2, -1, -1):
        solution[i] = d_prime[i] - c_prime[i] * solution[i + 1]
    return solution


def l2_relative_error(numeric, exact):
    """‖numeric-exact‖₂ / ‖exact‖₂（用 math.fsum 降低求和 roundoff）。"""
    diff_sq = math.fsum((a - b) * (a - b) for a, b in zip(numeric, exact))
    exact_sq = math.fsum(b * b for b in exact)
    if exact_sq <= 0.0:
        raise ValueError("精确解范数为 0，无法计算相对误差")
    return math.sqrt(diff_sq) / math.sqrt(exact_sq)


def pipe_fd(n, radius_m, length_m, mu_pa_s, pressure_drop_pa):
    """圆管泊肃叶有限差分代码验证（移植原脚本 pipe_fd，纯 Python 三对角求解）。"""
    if n < 3:
        raise ValueError(" pipe 需要 N>=3（壁面三阶单侧差分用到 u[n-2]），实际为 {}".format(n))
    h = radius_m / n
    gradient = -pressure_drop_pa / length_m
    lower = [0.0] * (n + 1)
    diag = [0.0] * (n + 1)
    upper = [0.0] * (n + 1)
    rhs = [0.0] * (n + 1)

    # 轴心：L'Hôpital 极限 2u'' = (1/μ) dp/dx → -4u[0]/h² + 4u[1]/h² = gradient/μ
    diag[0] = -4.0 / h ** 2
    upper[0] = 4.0 / h ** 2
    rhs[0] = gradient / mu_pa_s

    for i in range(1, n):
        r = i * h
        lower[i] = 1.0 / h ** 2 - 1.0 / (2.0 * h * r)
        diag[i] = -2.0 / h ** 2
        upper[i] = 1.0 / h ** 2 + 1.0 / (2.0 * h * r)
        rhs[i] = gradient / mu_pa_s

    # 壁面 no-slip
    diag[n] = 1.0
    rhs[n] = 0.0

    velocity = thomas_solve(lower, diag, upper, rhs)
    radius_nodes = [i * radius_m / n for i in range(n + 1)]
    factor = pressure_drop_pa / (4.0 * mu_pa_s * length_m)
    exact = [factor * (radius_m ** 2 - r ** 2) for r in radius_nodes]

    wall_gradient = (
        3.0 * velocity[-1] - 4.0 * velocity[-2] + velocity[-3]
    ) / (2.0 * h)
    wss_numeric = -mu_pa_s * wall_gradient
    wss_exact = pressure_drop_pa * radius_m / (2.0 * length_m)
    return {
        "n": n,
        "relative_L2_error": l2_relative_error(velocity, exact),
        "centerline_velocity_m_s": velocity[0],
        "centerline_exact_m_s": exact[0],
        "wss_numeric_pa": wss_numeric,
        "wss_exact_pa": wss_exact,
        "wss_relative_error": abs(wss_numeric - wss_exact) / wss_exact,
    }


def axisymmetric_cylinder_fem(n, inner_radius_m, outer_radius_m, young_modulus_pa,
                              poisson, internal_pressure_pa):
    """轴对称厚壁圆筒有限元（移植原脚本 axisymmetric_cylinder_fem，纯 Python）。"""
    if n < 1:
        raise ValueError("圆筒网格 N 必须 >=1，实际为 {}".format(n))
    nodes = [inner_radius_m + (outer_radius_m - inner_radius_m) * i / n for i in range(n + 1)]
    lam = young_modulus_pa * poisson / ((1.0 + poisson) * (1.0 - 2.0 * poisson))
    mu = young_modulus_pa / (2.0 * (1.0 + poisson))
    elasticity = ((lam + 2.0 * mu, lam), (lam, lam + 2.0 * mu))

    lower = [0.0] * (n + 1)
    diag = [0.0] * (n + 1)
    upper = [0.0] * (n + 1)
    force = [0.0] * (n + 1)

    gauss_points = (-math.sqrt(3.0 / 5.0), 0.0, math.sqrt(3.0 / 5.0))
    gauss_weights = (5.0 / 9.0, 8.0 / 9.0, 5.0 / 9.0)

    for element in range(n):
        r1 = nodes[element]
        r2 = nodes[element + 1]
        h = r2 - r1
        midpoint = 0.5 * (r1 + r2)
        local = [[0.0, 0.0], [0.0, 0.0]]
        for xi, weight in zip(gauss_points, gauss_weights):
            radius = midpoint + 0.5 * h * xi
            n1 = 0.5 * (1.0 - xi)
            n2 = 0.5 * (1.0 + xi)
            b = ((-1.0 / h, 1.0 / h), (n1 / radius, n2 / radius))
            # C·B 与 Bᵀ·(C·B)：显式展开，避免任何第三方线性代数
            cb00 = elasticity[0][0] * b[0][0] + elasticity[0][1] * b[1][0]
            cb01 = elasticity[0][0] * b[0][1] + elasticity[0][1] * b[1][1]
            cb10 = elasticity[1][0] * b[0][0] + elasticity[1][1] * b[1][0]
            cb11 = elasticity[1][0] * b[0][1] + elasticity[1][1] * b[1][1]
            scale = 2.0 * math.pi * radius * (0.5 * h) * weight
            local[0][0] += scale * (b[0][0] * cb00 + b[1][0] * cb10)
            local[0][1] += scale * (b[0][0] * cb01 + b[1][0] * cb11)
            local[1][0] += scale * (b[0][1] * cb00 + b[1][1] * cb10)
            local[1][1] += scale * (b[0][1] * cb01 + b[1][1] * cb11)
        diag[element] += local[0][0]
        upper[element] += local[0][1]
        lower[element + 1] += local[1][0]
        diag[element + 1] += local[1][1]

    # 内压按整周等效节点力加载
    force[0] = 2.0 * math.pi * inner_radius_m * internal_pressure_pa
    displacement = thomas_solve(lower, diag, upper, force)

    a2 = inner_radius_m ** 2
    b2 = outer_radius_m ** 2
    exact_factor = internal_pressure_pa * a2 / (young_modulus_pa * (b2 - a2))
    exact = [
        exact_factor * (
            (1.0 + poisson) * (1.0 - 2.0 * poisson) * r
            + (1.0 + poisson) * b2 / r
        )
        for r in nodes
    ]
    relative_error = l2_relative_error(displacement, exact)
    hoop_inner_exact = internal_pressure_pa * (b2 + a2) / (b2 - a2)

    # 用第一个单元内 Gauss 点恢复内壁环向应力（与原脚本同位置）
    r1, r2 = nodes[0], nodes[1]
    h = r2 - r1
    xi = -math.sqrt(3.0 / 5.0)
    radius = 0.5 * (r1 + r2) + 0.5 * h * xi
    n1 = 0.5 * (1.0 - xi)
    n2 = 0.5 * (1.0 + xi)
    b = ((-1.0 / h, 1.0 / h), (n1 / radius, n2 / radius))
    strain_axial = b[0][0] * displacement[0] + b[0][1] * displacement[1]
    strain_hoop = b[1][0] * displacement[0] + b[1][1] * displacement[1]
    stress_hoop = elasticity[1][0] * strain_axial + elasticity[1][1] * strain_hoop
    return {
        "n": n,
        "relative_L2_displacement_error": relative_error,
        "inner_displacement_fem_m": displacement[0],
        "inner_displacement_exact_m": exact[0],
        "inner_hoop_stress_fem_pa": stress_hoop,
        "inner_hoop_stress_exact_pa": hoop_inner_exact,
        "hoop_stress_relative_error": abs(stress_hoop - hoop_inner_exact) / hoop_inner_exact,
    }


# --------------------------------------------------------------------------
# 解析基准：flow / ring
# --------------------------------------------------------------------------

def flow_case(q_ml_min, radius_m, length_m, rho, mu):
    """单个流量点的泊肃叶解析基准。"""
    q = q_ml_min * 1e-6 / 60.0                 # mL/min → m³/s
    area = math.pi * radius_m ** 2
    velocity = q / area
    reynolds = rho * velocity * (2.0 * radius_m) / mu
    pressure_drop = 8.0 * mu * length_m * q / (math.pi * radius_m ** 4)
    wss = 4.0 * mu * q / (math.pi * radius_m ** 3)
    return {
        "Q_ml_min": float(q_ml_min),
        "mean_velocity_m_s": velocity,
        "Re": reynolds,
        "pressure_drop_pa": pressure_drop,
        "wss_pa": wss,
        "centerline_velocity_m_s": 2.0 * velocity,
    }


FLOW_FORMULAS = {
    "mean_velocity": "v_mean = Q / (pi * R^2)",
    "reynolds": "Re = rho * v_mean * (2R) / mu",
    "pressure_drop": "dP = 8 * mu * L * Q / (pi * R^4)",
    "wss": "tau_w = 4 * mu * Q / (pi * R^3)",
    "centerline": "u_max = 2 * v_mean（Poiseuille 抛物线解 u(r)=dP(R^2-r^2)/(4 mu L) 在 r=0 处）",
}

RING_FORMULA = "k_line = E * t^3 / (12 * R^3)  [N/m^2]；F(dR) = k_line * dR * 1mm  [N，每 1 mm 轴向长度]"


def ring_case(E_gpa, t_um, R_mm, displacements_mm):
    """连续薄环刚度尺度：k_line 与各径向位移下的力。"""
    E_pa = E_gpa * 1e9
    # 注意：厚度换算特意保留原脚本的 `t_um * 1e-6` 写法（而不是 t_um/1e6），
    # 两者相差 1 ulp；沿用原写法才能与 numpy 版结果做到 bit 级一致。
    t_m = t_um * 1e-6
    R_m = R_mm / 1000.0
    k_line = E_pa * t_m ** 3 / (12.0 * R_m ** 3)
    cases = []
    for dr_mm in displacements_mm:
        dr_m = dr_mm * 1e-3
        cases.append({
            "displacement_mm": float(dr_mm),
            "force_N_per_mm": k_line * dr_m * 1e-3,
        })
    return {
        "E_gPa": float(E_gpa),
        "thickness_um": float(t_um),
        "R_mm": float(R_mm),
        "k_line_N_m2": k_line,
        "displacement_cases": cases,
        "formula": RING_FORMULA,
    }


# --------------------------------------------------------------------------
# 材料数据（两个 CSV）
# --------------------------------------------------------------------------

_RANGE_RE = re.compile(
    r"^\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*(?:-|–|—|~|to|\.\.)\s*"
    r"([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*$"
)
_SINGLE_RE = re.compile(r"^\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*$")
_COMPARATOR_RE = re.compile(r"^\s*(?:>=|<=|>|<|≥|≤|~|≈|about)\s*(.+)$")


def parse_range(text):
    """把 CSV 里的 '3.00-4.00' / '250' / '>=0.20' / '-60' 解析为区间。

    返回 dict: text / kind (single|range|lower|upper|empty) / lo / hi / mid
    - 单值：lo=hi=mid=值
    - 区间：lo, hi, mid=(lo+hi)/2
    - 下限/上限：只填一侧，mid 取下限（保守取已知值）
    """
    raw = "" if text is None else str(text).strip()
    if raw == "":
        return {"text": "", "kind": "empty", "lo": None, "hi": None, "mid": None}
    match = _COMPARATOR_RE.match(raw)
    kind_hint = None
    if match and not _RANGE_RE.match(raw):
        comparator = raw[: len(raw) - len(match.group(1))]
        stripped = match.group(1).strip()
        kind_hint = "lower" if (">" in comparator) else "upper"
        raw_compare = stripped
        single = _SINGLE_RE.match(raw_compare)
        if single:
            value = float(single.group(1))
            return {
                "text": "" if text is None else str(text).strip(),
                "kind": kind_hint,
                "lo": value if kind_hint == "lower" else None,
                "hi": value if kind_hint == "upper" else None,
                "mid": value,
            }
    range_match = _RANGE_RE.match(raw)
    if range_match:
        lo = float(range_match.group(1))
        hi = float(range_match.group(2))
        if hi < lo:
            lo, hi = hi, lo
        return {
            "text": str(text).strip(),
            "kind": "range",
            "lo": lo,
            "hi": hi,
            "mid": 0.5 * (lo + hi),
        }
    single = _SINGLE_RE.match(raw)
    if single:
        value = float(single.group(1))
        return {
            "text": str(text).strip(),
            "kind": "single",
            "lo": value,
            "hi": value,
            "mid": value,
        }
    return {"text": str(text).strip(), "kind": "text", "lo": None, "hi": None, "mid": None}


def _find_data_file(exact_name, pattern):
    """按精确名找，找不到就用 glob 回退；再找不到报错。"""
    candidate = DATA_DIR / exact_name
    if candidate.exists():
        return candidate
    matches = sorted(DATA_DIR.glob(pattern))
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        _fatal("数据目录中存在多个匹配 {!r} 的文件，请保留唯一一份：{}".format(
            pattern, ", ".join(str(m) for m in matches)))
    _fatal("数据文件缺失：{}\n  期望路径 {}\n  或匹配 {!r} 的唯一文件".format(
        exact_name, candidate, pattern))


def normalize_family(family_raw, material_name=""):
    """把 CSV 的「材料族」归一到 --family 用的 Mg/Zn/Fe/polymer。"""
    raw = (family_raw or "").strip()
    lowered = raw.lower()
    if "mg" in lowered or "magnesium" in lowered or raw.startswith("镁"):
        return "Mg"
    if "zn" in lowered or "zinc" in lowered or raw.startswith("锌"):
        return "Zn"
    if "fe" in lowered or "iron" in lowered or raw.startswith("铁"):
        return "Fe"
    if any(token in lowered for token in ("polymer", "聚合物")) or raw.upper() in (
        "PLLA", "PLGA", "PCL", "PDO", "PLA", "PGA",
    ) or any(token in (material_name or "").upper() for token in ("PLLA", "PLGA", "PCL", "PDO")):
        return "polymer"
    return raw or "unknown"


def load_materials():
    """读汇总 CSV 为主表，明细 CSV 用于补齐缺失数值与区间信息。"""
    summary_path = _find_data_file(SUMMARY_CSV_NAME, "MatWeb*汇总*.csv")
    detail_path = _find_data_file(DETAIL_CSV_NAME, "*属性明细*.csv")

    # 明细表：material_id → {统一键: 行}
    detail = {}
    with detail_path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            material_id = (row.get("material_id") or "").strip()
            key = DETAIL_KEYS.get((row.get("属性") or "").strip())
            if not material_id or not key:
                continue
            detail.setdefault(material_id, {}).setdefault(key, row)

    materials = []
    with summary_path.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            material_id = (row.get("material_id") or "").strip()
            if not material_id:
                continue
            name = (row.get("材料") or "").strip()
            family_raw = (row.get("材料族") or "").strip()
            material = {
                "id": material_id,
                "name": name,
                "family_raw": family_raw,
                "family": normalize_family(family_raw, name),
                "form": (row.get("状态/形态") or "").strip(),
                "grade": (row.get("标准/牌号") or "").strip(),
                "composition": (row.get("主要成分") or "").strip(),
                "density": parse_range(row.get("密度-g/cm3")),
                "tensile": parse_range(row.get("抗拉强度-MPa")),
                "yield": parse_range(row.get("屈服强度-MPa")),
                "elongation": parse_range(row.get("断裂伸长率-%")),
                "modulus": parse_range(row.get("弹性模量-GPa")),
                "melting": parse_range(row.get("熔点-C")),
                "tg": parse_range(row.get("玻璃化温度-C")),
                "mass_loss": parse_range(row.get("完全质量损失-月")),
                "fda": (row.get("FDA合规") or "").strip(),
                "usage": (row.get("数据用途") or "").strip(),
                "source": (row.get("来源") or "").strip(),
                "url": (row.get("原始URL") or "").strip(),
                "accessed": (row.get("访问日期") or "").strip(),
            }
            # 明细表补缺（只在汇总为空时使用，不覆盖已有值）
            extra = detail.get(material_id, {})
            for key, detail_key in (
                ("density", "density"), ("tensile", "tensile"), ("yield", "yield"),
                ("elongation", "elongation"), ("modulus", "modulus"),
                ("melting", "melting"), ("tg", "tg"), ("mass_loss", "mass_loss"),
            ):
                if material[key]["kind"] == "empty":
                    source_row = extra.get(detail_key)
                    if source_row:
                        material[key] = parse_range(source_row.get("值文本"))
            materials.append(material)

    if not materials:
        _fatal("材料汇总表没有读到任何数据行：{}".format(summary_path))
    return materials, summary_path, detail_path


def material_is_degradable(material):
    """--degradable 口径：数据集中有「完全质量损失时间」（可吸收/降解动力学口径）。

    Mg/Zn/Fe 现实中是可降解金属，但本数据集只有基础物性、没有腐蚀动力学，
    因此不满足该口径；此类金属请用 --family Mg|Zn|Fe 单独查看。
    """
    return material["mass_loss"]["kind"] != "empty"


def _material_json(material):
    def pack(entry):
        return {
            "text": entry["text"],
            "kind": entry["kind"],
            "lo": entry["lo"],
            "hi": entry["hi"],
            "mid": entry["mid"],
        }

    return {
        "id": material["id"],
        "name": material["name"],
        "family": material["family"],
        "family_raw": material["family_raw"],
        "form": material["form"],
        "grade": material["grade"],
        "composition": material["composition"],
        "density_g_cm3": pack(material["density"]),
        "modulus_gpa": pack(material["modulus"]),
        "tensile_mpa": pack(material["tensile"]),
        "yield_mpa": pack(material["yield"]),
        "elongation_pct": pack(material["elongation"]),
        "melting_c": pack(material["melting"]),
        "tg_c": pack(material["tg"]),
        "mass_loss_months": pack(material["mass_loss"]),
        "fda_compliant": material["fda"],
        "data_usage": material["usage"],
        "source": material["source"],
        "source_url": material["url"],
        "accessed": material["accessed"],
        "degradable_by_dataset": material_is_degradable(material),
    }


def _material_text(entry):
    """表格里优先显示原始文本（保留区间写法），空值显示 '-'。"""
    return entry["text"] if entry["kind"] != "empty" else "-"


# --------------------------------------------------------------------------
# 命令：materials
# --------------------------------------------------------------------------

def cmd_materials(args):
    materials, summary_path, detail_path = load_materials()

    families = ("Mg", "Zn", "Fe", "polymer")
    selected = materials
    if args.family:
        family = args.family
        if family not in families:
            _fatal("--family 只接受 {}，收到 {!r}".format("/".join(families), family))
        selected = [m for m in selected if m["family"] == family]
    if args.degradable:
        selected = [m for m in selected if material_is_degradable(m)]
    if args.min_tensile is not None:
        kept = []
        for material in selected:
            mid = material["tensile"]["mid"]
            if mid is None:
                continue        # 无抗拉数据的材料无法参与阈值筛选，直接排除（并在输出中说明）
            if mid >= args.min_tensile:
                kept.append(material)
        selected = kept

    key_map = {"E": "modulus", "tensile": "tensile"}
    if args.sort in key_map:
        key = key_map[args.sort]
        # 缺该属性的材料排到末尾；默认降序（大→小），--asc 改为升序
        selected = sorted(
            selected,
            key=lambda m: (m[key]["mid"] is None, m[key]["mid"] if m[key]["mid"] is not None else 0.0),
            reverse=not args.asc,
        )
    elif args.sort == "name":
        # 名称默认升序，--asc 无额外含义（保持升序）
        selected = sorted(selected, key=lambda m: m["name"], reverse=False)

    filters = {
        "family": args.family,
        "degradable": bool(args.degradable),
        "min_tensile_mpa": args.min_tensile,
        "sort": args.sort,
        "ascending": bool(args.asc),
    }

    if args.json:
        print(json.dumps({
            "command": "materials",
            "version": VERSION,
            "filters": filters,
            "count": len(selected),
            "materials": [_material_json(m) for m in selected],
            "data_files": [_file_provenance(summary_path), _file_provenance(detail_path)],
            "notes": [
                "E/抗拉/伸长等区间取 MatWeb 原文；数值比较用区间中点（mid）",
                "--degradable 的口径 = 数据集中有「完全质量损失时间」；Mg/Zn/Fe 缺腐蚀动力学，不在其中",
                "材料数据仅 MatWeb 基础物性，不含腐蚀/水解动力学、疲劳、血液相容性或体内数据",
            ],
        }, ensure_ascii=False, indent=2))
        return 0

    print("材料对比（来源 {}；共 {} 条，筛选后 {} 条）".format(
        summary_path.name, len(materials), len(selected)))
    if args.family or args.degradable or args.min_tensile is not None:
        parts = []
        if args.family:
            parts.append("family={}".format(args.family))
        if args.degradable:
            parts.append("degradable=True")
        if args.min_tensile is not None:
            parts.append("min_tensile={}MPa".format(_num(args.min_tensile)))
        print("筛选：{}".format("，".join(parts)))
    if args.sort:
        order = "升序" if (args.sort == "name" or args.asc) else "降序"
        print("排序：{}（{}）".format(args.sort, order))

    headers = ["材料", "族", "密度\ng/cm3", "E\nGPa", "抗拉\nMPa", "屈服\nMPa",
               "伸长\n%", "熔点\n°C", "Tg\n°C", "完全质量\n损失/月", "FDA"]
    # 多行表头在简单表格里不便处理，改用单行带单位
    headers = ["材料", "族", "密度(g/cm3)", "E(GPa)", "抗拉(MPa)", "屈服(MPa)",
               "伸长(%)", "熔点(C)", "Tg(C)", "质量损失(月)", "FDA"]
    rows = []
    for material in selected:
        rows.append([
            material["name"],
            material["family"],
            _material_text(material["density"]),
            _material_text(material["modulus"]),
            _material_text(material["tensile"]),
            _material_text(material["yield"]),
            _material_text(material["elongation"]),
            _material_text(material["melting"]),
            _material_text(material["tg"]),
            _material_text(material["mass_loss"]),
            material["fda"] or "-",
        ])
    _print_table(headers, rows,
                 aligns=["l", "l", "r", "r", "r", "r", "r", "r", "r", "r", "l"])

    print("")
    print("数据用途与来源：")
    detail_rows = [[m["name"], m["usage"] or "-", m["url"] or "-"] for m in selected]
    _print_table(["材料", "数据用途", "来源URL"], detail_rows, aligns=["l", "l", "l"])
    print("")
    print("口径提醒：")
    print("  * E/抗拉/伸长等区间按 MatWeb 原文显示；做数值计算时用区间中点（--json 的 mid 字段）。")
    print("  * --degradable = 数据集中有「完全质量损失时间」；Mg/Zn/Fe 是可降解金属但无腐蚀动力学数据。")
    print("  * 材料数据仅基础物性，不含降解/疲劳/血液相容性/体内数据；不可外推为临床结论。")
    return 0


# --------------------------------------------------------------------------
# 命令：ring
# --------------------------------------------------------------------------

def _parse_displacements(values):
    """--displacement 支持 0.1 0.2 或 0.1,0.2，也支持重复传参。"""
    flat = []
    for value in values:
        for token in str(value).replace("，", ",").split(","):
            token = token.strip()
            if token == "":
                continue
            try:
                number = float(token)
            except ValueError:
                raise argparse.ArgumentTypeError(
                    "--displacement 需要数值（mm），收到 {!r}".format(token))
            if number < 0:
                raise argparse.ArgumentTypeError("--displacement 不能为负：{}".format(number))
            flat.append(number)
    return flat


def cmd_ring(args):
    if args.E <= 0:
        _fatal("--E 必须 > 0（单位 GPa），收到 {}".format(args.E))
    if args.t <= 0:
        _fatal("--t 必须 > 0（单位 μm），收到 {}".format(args.t))
    if args.R <= 0:
        _fatal("--R 必须 > 0（单位 mm），收到 {}".format(args.R))
    displacements = (
        _parse_displacements(args.displacement)
        if args.displacement
        else list(RING_DISPLACEMENTS_MM)
    )
    if not displacements:
        _fatal("--displacement 至少需要一个数值")

    result = ring_case(args.E, args.t, args.R, displacements)
    result["material"] = args.material
    if args.json:
        print(json.dumps({
            "command": "ring",
            "version": VERSION,
            "material": args.material,
            "E_gPa": result["E_gPa"],
            "thickness_um": result["thickness_um"],
            "R_mm": result["R_mm"],
            "k_line_N_m2": result["k_line_N_m2"],
            "formula": result["formula"],
            "displacement_cases": result["displacement_cases"],
            "notes": [
                "k_line 是连续薄环刚度尺度（单位 N/m²），不是成品支架径向力",
                "force_N_per_mm = k_line * dR * 1mm，表示每 1 mm 轴向长度的力；成品支架需台架校准",
            ],
        }, ensure_ascii=False, indent=2))
        return 0

    print("连续薄环刚度尺度：k_line = E t^3 / (12 R^3)")
    print("  E = {} GPa，t = {} um，R = {} mm".format(
        _num(result["E_gPa"]), _num(result["thickness_um"]), _num(result["R_mm"])))
    print("  k_line = {} N/m2".format(_num(result["k_line_N_m2"], sig=8)))
    rows = []
    for case in result["displacement_cases"]:
        rows.append([
            _num(case["displacement_mm"]),
            _num(case["displacement_mm"] * 1e-3, sig=4),
            _num(case["force_N_per_mm"], sig=6),
        ])
    _print_table(["dR(mm)", "dR(m)", "F(N 每 1 mm 轴向长度)"], rows, aligns=["r", "r", "r"])
    print("")
    print("红线：k_line 只是数量级检查；开孔单元、桥筋、摩擦和接触会显著改变有效刚度，")
    print("      成品径向力必须由压握-扩张/径向力-位移台架校准。")
    return 0


# --------------------------------------------------------------------------
# 命令：flow
# --------------------------------------------------------------------------

def _flow_params(args):
    if args.R <= 0:
        _fatal("--R 必须 > 0（mm），收到 {}".format(args.R))
    if args.L <= 0:
        _fatal("--L 必须 > 0（mm），收到 {}".format(args.L))
    if args.rho <= 0:
        _fatal("--rho 必须 > 0（kg/m3），收到 {}".format(args.rho))
    if args.mu <= 0:
        _fatal("--mu 必须 > 0（Pa·s），收到 {}".format(args.mu))
    q_values = args.q if args.q else [Q_BASELINE_ML_MIN]
    for q in q_values:
        if q <= 0:
            _fatal("--q 必须 > 0（mL/min），收到 {}".format(q))
    # mm → m 用除以 1000.0：与字面量 18e-3 相同的正确舍入结果，
    # 而 18.0*1e-3 会得到 0.018000000000000002（与原脚本差 1 ulp）。
    return args.R / 1000.0, args.L / 1000.0, args.rho, args.mu, q_values


def _flow_rows(q_values, radius_m, length_m, rho, mu):
    return [flow_case(q, radius_m, length_m, rho, mu) for q in q_values]


def _print_flow_table(rows):
    table_rows = []
    for row in rows:
        table_rows.append([
            _num(row["Q_ml_min"]),
            _num(row["mean_velocity_m_s"]),
            _num(row["Re"]),
            _num(row["pressure_drop_pa"]),
            _num(row["wss_pa"]),
            _num(row["centerline_velocity_m_s"]),
        ])
    _print_table(
        ["Q(mL/min)", "平均流速(m/s)", "Re", "压降(Pa)", "WSS(Pa)", "中心线(m/s)"],
        table_rows, aligns=["r"] * 6)


def cmd_flow(args):
    radius_m, length_m, rho, mu, q_values = _flow_params(args)
    rows = _flow_rows(q_values, radius_m, length_m, rho, mu)
    if args.json:
        print(json.dumps({
            "command": "flow",
            "version": VERSION,
            "inputs": {
                "R_mm": args.R, "R_m": radius_m,
                "L_mm": args.L, "L_m": length_m,
                "rho_kg_m3": rho, "mu_pa_s": mu,
                "q_ml_min": q_values,
            },
            "formulas": FLOW_FORMULAS,
            "cases": rows,
            "notes": [
                "稳态牛顿流体直管（Poiseuille）基准；水力直径取 2R",
                "100 mL/min 基线应与 docx §8.1 一致：v≈0.2358 m/s、Re≈483.36、dP≈22.64 Pa、WSS≈0.9431 Pa、中心线≈0.47157 m/s",
                "WSS 数值不是患者阈值；脉动流/FSI 需另行建模",
            ],
        }, ensure_ascii=False, indent=2))
        return 0

    print("圆管泊肃叶基准：R={} mm，L={} mm，rho={} kg/m3，mu={} Pa·s".format(
        _num(args.R), _num(args.L), _num(rho), _num(mu)))
    print("公式：v=Q/(πR²)，Re=ρv(2R)/μ，Δp=8μLQ/(πR⁴)，τ_w=4μQ/(πR³)，u_max=2v")
    _print_flow_table(rows)
    print("")
    print("红线：稳态牛顿流体直管基准，不是患者血流阈值；脉动流/FSI 需另行建模。")
    return 0


# --------------------------------------------------------------------------
# 命令：verify
# --------------------------------------------------------------------------

def _parse_n_values(values):
    """--n 支持 '20,40,80' 或 '20 40 80' 或重复传参；去重并保持输入顺序。"""
    flat = []
    for value in values:
        for token in str(value).replace("，", ",").split(","):
            token = token.strip()
            if token == "":
                continue
            try:
                number = int(token)
            except ValueError:
                raise ValueError("--n 需要整数网格数，收到 {!r}".format(token))
            if number < 1:
                raise ValueError("--n 必须 >= 1，收到 {}".format(number))
            if number > 20000:
                raise ValueError("--n 过大（>20000），请缩小：{}".format(number))
            if number not in flat:
                flat.append(number)
    if not flat:
        raise ValueError("--n 至少要有一个网格数")
    return flat


def _add_check(checks, name, computed, reference, tolerance, unit="", note=""):
    """登记一条自检：|computed-reference|/|reference| <= tolerance。"""
    if reference == 0:
        relative = abs(computed - reference)
    else:
        relative = abs(computed - reference) / abs(reference)
    checks.append({
        "name": name,
        "computed": computed,
        "reference": reference,
        "relative_deviation": relative,
        "tolerance": tolerance,
        "unit": unit,
        "passed": bool(relative <= tolerance),
        "note": note,
    })


def _add_bound_check(checks, name, computed, bound, unit="", note=""):
    """登记一条上限判据（V0 判据式）：computed <= bound 视为通过。"""
    checks.append({
        "name": name,
        "computed": computed,
        "reference": bound,
        "relation": "computed <= bound",
        "relative_deviation": None,
        "tolerance": None,
        "unit": unit,
        "passed": bool(computed <= bound),
        "note": note,
    })


# 物理量用 1e-9（原脚本 numpy 与本脚本 Thomas 的 roundoff 差异 ~1e-13~1e-11）；
# 无量纲误差比值用 1e-3：‖u-exact‖ 是两个几乎相等的量相减，roundoff 被放大，
# N=320 时放大倍数 ~1e5（详见 compare.md）。
TOL_PHYS = 1.0e-9
TOL_RATIO = 1.0e-3


def _run_verify(n_values, do_pipe=True, do_cylinder=True):
    """跑验证算例并生成自检清单。返回 (baseline_flow, pipe_rows, cyl_rows, checks)。"""
    radius_m = R_MM_DEFAULT / 1000.0
    length_m = L_MM_DEFAULT / 1000.0
    baseline = flow_case(Q_BASELINE_ML_MIN, radius_m, length_m, RHO_DEFAULT, MU_DEFAULT)
    pressure_drop_ref = baseline["pressure_drop_pa"]

    checks = []
    _add_check(checks, "flow.平均流速", baseline["mean_velocity_m_s"],
               FLOW_REF["mean_velocity_m_s"], TOL_PHYS, "m/s", "docx §8.1 / 原脚本 flow_window")
    _add_check(checks, "flow.Re", baseline["Re"], FLOW_REF["Re"], TOL_PHYS, "-", "docx: Re≈483.36")
    _add_check(checks, "flow.压降", baseline["pressure_drop_pa"],
               FLOW_REF["pressure_drop_pa"], TOL_PHYS, "Pa", "docx: Δp≈22.64 Pa")
    _add_check(checks, "flow.WSS", baseline["wss_pa"], FLOW_REF["wss_pa"],
               TOL_PHYS, "Pa", "docx: WSS≈0.9431 Pa")
    _add_check(checks, "flow.中心线流速", baseline["centerline_velocity_m_s"],
               FLOW_REF["centerline_velocity_m_s"], TOL_PHYS, "m/s", "docx: 0.471570 m/s")

    pipe_rows = []
    if do_pipe:
        for n in n_values:
            pipe_rows.append(pipe_fd(n, radius_m, length_m, MU_DEFAULT, pressure_drop_ref))
        if pipe_rows:
            finest_pipe = pipe_rows[0]
            _add_check(checks, "pipe.N{}.中心线流速".format(finest_pipe["n"]),
                       finest_pipe["centerline_velocity_m_s"],
                       PIPE_REF["centerline_velocity_m_s"], TOL_PHYS, "m/s",
                       "壁面 no-slip + r=0 L'Hôpital 的 FD 解")
            _add_check(checks, "pipe.N{}.WSS".format(finest_pipe["n"]),
                       finest_pipe["wss_numeric_pa"], PIPE_REF["wss_pa"], TOL_PHYS, "Pa",
                       "壁面三点单侧三阶差分 τ_w=-μu'(R)")
            max_l2 = max(row["relative_L2_error"] for row in pipe_rows)
            _add_bound_check(checks, "pipe.最大相对L2误差", max_l2, PIPE_REF["l2_abs_max"], "-",
                             "V0 判据（docx 表 5）：流速误差 ≤1e-10；全部网格均须满足")

    cylinder_rows = []
    if do_cylinder:
        for n in n_values:
            cylinder_rows.append(axisymmetric_cylinder_fem(
                n, CYL_RI_M, CYL_RO_M, CYL_E_PA, CYL_NU, CYL_PRESSURE_PA))
        by_n = {row["n"]: row for row in cylinder_rows}
        for n in (20, 320):
            if n not in by_n:
                continue
            row = by_n[n]
            reference = CYL_REF[n]
            _add_check(checks, "cyl.N{}.位移L2误差".format(n),
                       row["relative_L2_displacement_error"],
                       reference["rel_L2_displacement_error"], TOL_RATIO, "-",
                       "参考值来自原脚本 numpy 实跑；比值对 roundoff 敏感")
            _add_check(checks, "cyl.N{}.内壁位移".format(n),
                       row["inner_displacement_fem_m"],
                       reference["inner_displacement_fem_m"], TOL_PHYS, "m",
                       "解析 70.0083 μm")
            _add_check(checks, "cyl.N{}.内壁环向应力".format(n),
                       row["inner_hoop_stress_fem_pa"],
                       reference["inner_hoop_stress_fem_pa"], TOL_PHYS, "Pa",
                       "解析 47.615 kPa")
            _add_check(checks, "cyl.N{}.环向应力相对误差".format(n),
                       row["hoop_stress_relative_error"],
                       reference["hoop_stress_relative_error"], TOL_RATIO, "-",
                       "docx 表 6：3.402% / 0.217%")

        # docx 表 5 的 V0 判据（位移/应力相对误差 ≤2%）是「生产网格」判据：
        # 只在本次运行的最细网格 >=160 时登记，避免只跑粗网格时误报失败
        # （N=20 的环向应力误差 3.402% 本来就超 2%，见 compare.md 的口径说明）。
        production_n = max(n_values)
        if production_n >= 160 and production_n in by_n:
            row = by_n[production_n]
            _add_bound_check(checks, "cyl.N{}.位移L2<=2%".format(production_n),
                             row["relative_L2_displacement_error"], 0.02, "-",
                             "V0 判据（docx 表 5）：生产网格位移误差 ≤2%")
            _add_bound_check(checks, "cyl.N{}.环向应力误差<=2%".format(production_n),
                             row["hoop_stress_relative_error"], 0.02, "-",
                             "V0 判据（docx 表 5）：生产网格应力误差 ≤2%")
    return baseline, pipe_rows, cylinder_rows, checks


def _checks_passed(checks):
    return all(check["passed"] for check in checks)


def _print_pipe_table(rows):
    table_rows = []
    for row in rows:
        table_rows.append([
            str(row["n"]),
            _num(row["relative_L2_error"], sig=4),
            _num(row["centerline_velocity_m_s"], sig=9),
            _num(row["centerline_exact_m_s"], sig=9),
            _num(row["wss_numeric_pa"], sig=9),
            _num(row["wss_exact_pa"], sig=9),
            _num(row["wss_relative_error"], sig=3),
        ])
    print("[Poiseuille 圆管有限差分]（三对角 Thomas 求解；与解析抛物线解比）")
    _print_table(["N", "相对L2误差", "中心线FD(m/s)", "中心线解析(m/s)",
                  "WSS_FD(Pa)", "WSS解析(Pa)", "WSS相对误差"], table_rows,
                 aligns=["r"] * 7)


def _print_cyl_table(rows):
    table_rows = []
    for row in rows:
        table_rows.append([
            str(row["n"]),
            _num(row["relative_L2_displacement_error"], sig=4),
            _num(row["inner_displacement_fem_m"] * 1e6, sig=7),
            _num(row["inner_displacement_exact_m"] * 1e6, sig=7),
            _num(row["inner_hoop_stress_fem_pa"] / 1e3, sig=6),
            _num(row["inner_hoop_stress_exact_pa"] / 1e3, sig=6),
            _num(row["hoop_stress_relative_error"] * 100.0, sig=4) + "%",
        ])
    print("[轴对称厚壁圆筒 FEM]（3 点 Gauss、2πr 积分、内压 13332.2 Pa）")
    _print_table(["N", "位移L2相对误差", "内壁u_FEM(um)", "内壁u_解析(um)",
                  "环向σθ_FEM(kPa)", "环向σθ_解析(kPa)", "相对误差"], table_rows,
                 aligns=["r"] * 7)


def _print_checks(checks):
    if not checks:
        print("[自检] 无检查项（--pipe/--cylinder 都未启用？）")
        return
    failed = [check for check in checks if not check["passed"]]
    print("[自检] {} 项，通过 {} 项，失败 {} 项".format(
        len(checks), len(checks) - len(failed), len(failed)))
    rows = []
    for check in checks:
        rows.append([
            check["name"],
            _num(check["computed"], sig=6),
            _num(check["reference"], sig=6),
            _num(check.get("relative_deviation"), sig=3),
            _num(check.get("tolerance"), sig=2),
            "通过" if check["passed"] else "失败",
        ])
    _print_table(["检查项", "计算值", "参考值", "相对偏差", "容差", "结果"], rows,
                 aligns=["l", "r", "r", "r", "r", "l"])
    if failed:
        print("")
        for check in failed:
            if check.get("tolerance") is None:
                print("  失败：{}（计算 {} > 上限 {}）".format(
                    check["name"], _num(check["computed"], sig=8),
                    _num(check["reference"], sig=8)))
            else:
                print("  失败：{}（计算 {} vs 参考 {}，偏差 {} > 容差 {}）".format(
                    check["name"], _num(check["computed"], sig=8),
                    _num(check["reference"], sig=8),
                    _num(check["relative_deviation"], sig=3),
                    _num(check["tolerance"], sig=2)))


def cmd_verify(args):
    if args.n:
        try:
            n_values = _parse_n_values(args.n)
        except ValueError as exc:
            # 走统一的错误出口（stderr + 退出码 2），不要抛 argparse 异常让宿主看到 traceback
            _fatal(str(exc))
    else:
        n_values = list(VERIFY_N_DEFAULT)
    do_pipe = bool(args.pipe)
    do_cylinder = bool(args.cylinder)
    if not do_pipe and not do_cylinder:
        do_pipe = do_cylinder = True
    if do_pipe and any(n < 3 for n in n_values):
        _fatal("圆管有限差分要求所有 N>=3（壁面三阶单侧差分），收到 {}".format(n_values))

    baseline, pipe_rows, cylinder_rows, checks = _run_verify(n_values, do_pipe, do_cylinder)
    passed = _checks_passed(checks)

    if args.json:
        print(json.dumps({
            "command": "verify",
            "version": VERSION,
            "n_values": n_values,
            "baseline_flow": baseline,
            "pipe_fd": pipe_rows,
            "axisymmetric_cylinder_fem": cylinder_rows,
            "inputs": {
                "pipe_fd": {
                    "R_mm": R_MM_DEFAULT, "L_mm": L_MM_DEFAULT,
                    "mu_pa_s": MU_DEFAULT, "pressure_drop_pa": baseline["pressure_drop_pa"],
                    "pressure_drop_source": "flow_case(100 mL/min) 的解析压降，与原脚本一致",
                },
                "cylinder": {
                    "inner_radius_m": CYL_RI_M, "outer_radius_m": CYL_RO_M,
                    "young_modulus_pa": CYL_E_PA, "poisson": CYL_NU,
                    "internal_pressure_pa": CYL_PRESSURE_PA,
                },
            },
            "checks": checks,
            "self_check_passed": passed,
            "notes": [
                "参考值由原脚本（numpy 版）实跑得到：_work/tool-check/orig-run/",
                "物理量容差 1e-9 覆盖 solver roundoff；无量纲误差比值容差 1e-3（相减放大 roundoff）",
                "这些是数值实现自检，不是临床验证",
            ],
        }, ensure_ascii=False, indent=2))
        return 0 if passed else 1

    print("数值实现自检（N = {}）".format(", ".join(str(n) for n in n_values)))
    print("基线流量 100 mL/min：v={} m/s，Re={}，Δp={} Pa，WSS={} Pa，中心线={} m/s".format(
        _num(baseline["mean_velocity_m_s"]), _num(baseline["Re"]),
        _num(baseline["pressure_drop_pa"]), _num(baseline["wss_pa"]),
        _num(baseline["centerline_velocity_m_s"])))
    print("")
    if pipe_rows:
        _print_pipe_table(pipe_rows)
        print("")
    if cylinder_rows:
        _print_cyl_table(cylinder_rows)
        print("")
    _print_checks(checks)
    print("")
    print("红线：这些只证明公式与实现自洽（V0 代码验证），不构成临床或监管验证。")
    if not passed:
        sys.stderr.write("错误：自检未通过，见上方失败项\n")
        return 1
    return 0


# --------------------------------------------------------------------------
# 命令：all
# --------------------------------------------------------------------------

def cmd_all(args):
    n_values = list(VERIFY_N_DEFAULT)
    radius_m = R_MM_DEFAULT / 1000.0
    length_m = L_MM_DEFAULT / 1000.0
    flow_rows = _flow_rows(list(FLOW_WINDOW_ML_MIN), radius_m, length_m,
                           RHO_DEFAULT, MU_DEFAULT)
    baseline, pipe_rows, cylinder_rows, checks = _run_verify(n_values, True, True)
    ring_rows = []
    for case in RING_CASES:
        item = ring_case(case["E_gPa"], case["t_um"], R_MM_DEFAULT,
                         list(RING_DISPLACEMENTS_MM))
        item["material"] = case["material"]
        item["family"] = case["family"]
        item["E_source_note"] = case["note"]
        ring_rows.append(item)
    passed = _checks_passed(checks)

    # 数据文件 provenance：all 是写入 provenance 的命令，数据缺失属于明确的输入错误
    data_files = [
        _file_provenance(_find_data_file(SUMMARY_CSV_NAME, "MatWeb*汇总*.csv")),
        _file_provenance(_find_data_file(DETAIL_CSV_NAME, "*属性明细*.csv")),
    ]

    payload = {
        "schema": "scitag.vascular-stent.provenance/v1",
        "tool": "stent_tool.py",
        "version": VERSION,
        "command": "all",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "inputs": {
            "geometry": {
                "R_mm": R_MM_DEFAULT, "R_m": radius_m,
                "L_mm": L_MM_DEFAULT, "L_m": length_m,
            },
            "fluid": {"rho_kg_m3": RHO_DEFAULT, "mu_pa_s": MU_DEFAULT},
            "q_baseline_ml_min": Q_BASELINE_ML_MIN,
            "flow_window_ml_min": list(FLOW_WINDOW_ML_MIN),
            "pipe_fd": {
                "n_values": n_values,
                "pressure_drop_pa": baseline["pressure_drop_pa"],
                "pressure_drop_source": "flow_case(100 mL/min) 解析压降（与原脚本一致）",
            },
            "cylinder": {
                "n_values": n_values,
                "inner_radius_m": CYL_RI_M,
                "outer_radius_m": CYL_RO_M,
                "young_modulus_pa": CYL_E_PA,
                "poisson": CYL_NU,
                "internal_pressure_pa": CYL_PRESSURE_PA,
            },
            "ring_cases": [
                {
                    "material": case["material"],
                    "E_gPa": case["E_gPa"],
                    "thickness_um": case["t_um"],
                    "R_mm": R_MM_DEFAULT,
                    "displacements_mm": list(RING_DISPLACEMENTS_MM),
                    "E_source_note": case["note"],
                }
                for case in RING_CASES
            ],
            "data_files": data_files,
        },
        "cases": {
            "flow_window": flow_rows,
            "pipe_fd_verification": pipe_rows,
            "axisymmetric_cylinder_verification": cylinder_rows,
            "ring_scaling": ring_rows,
        },
        "checks": checks,
        "self_check_passed": passed,
        "limitations": list(LIMITATIONS),
        "references": {
            "source_script": "stent-raw/血管支架计算验证.py（numpy+PIL 版，数值逻辑来源）",
            "baseline_table": "stent-domain/_work/docx/docx-text.md 第 124-142 行（§8.1/§8.2、表 6、式 19）",
            "material_data": "data/MatWeb材料汇总_2026-10-18.csv + data/MatWeb属性明细_2026-10-18.csv",
            "original_run": "stent-domain/_work/tool-check/orig-run/stent_model_validation_artifacts/stent_model_validation_summary.json",
        },
        "red_lines": [
            "数值实现自检（V0 代码验证）+ 数量级尺度检查，不是临床/监管验证",
            "连续薄环 ≠ 成品支架径向力；成品需台架校准",
            "稳态牛顿流体直管 ≠ 患者血流；WSS 不可外推为临床阈值",
        ],
    }

    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0 if passed else 1

    print("=" * 78)
    print("vascular-stent 工具汇总（stent_tool.py {}）".format(VERSION))
    print("=" * 78)
    print("输入：R={} mm，L={} mm，rho={} kg/m3，mu={} Pa·s；基线 Q={} mL/min".format(
        R_MM_DEFAULT, L_MM_DEFAULT, _num(RHO_DEFAULT), _num(MU_DEFAULT),
        _num(Q_BASELINE_ML_MIN)))
    print("")
    print("[流量窗口]")
    _print_flow_table(flow_rows)
    print("")
    _print_pipe_table(pipe_rows)
    print("")
    _print_cyl_table(cylinder_rows)
    print("")
    print("[连续薄环刚度尺度] R = {} mm".format(R_MM_DEFAULT))
    ring_table = []
    for item in ring_rows:
        forces = [case["force_N_per_mm"] for case in item["displacement_cases"]]
        ring_table.append([
            item["material"],
            _num(item["E_gPa"]),
            _num(item["thickness_um"]),
            _num(item["k_line_N_m2"], sig=7),
            _num(forces[0] if len(forces) > 0 else None, sig=5),
            _num(forces[1] if len(forces) > 1 else None, sig=5),
        ])
    _print_table(["材料", "E(GPa)", "t(um)", "k_line(N/m2)",
                  "F@0.1mm(N/mm)", "F@0.2mm(N/mm)"], ring_table,
                 aligns=["l", "r", "r", "r", "r", "r"])
    print("")
    _print_checks(checks)
    print("")
    print("[限制]（写入 provenance 的 limitations 字段）")
    for item in LIMITATIONS:
        print("  - {}".format(item))
    print("")
    print("JSON：python stent_tool.py all --json > all.json")
    return 0 if passed else 1


# --------------------------------------------------------------------------
# 命令：concept —— 概念筛选（药物涂层支架 vs 封堵/栓塞器件）
# --------------------------------------------------------------------------

HEALING_WINDOW_MONTHS = (1.0, 3.0)      # 内皮化/愈合时间窗（文献级假设，不是本数据集结论）
DEFECT_SIZES_MM = (3.0, 4.0, 5.0, 6.0, 8.0)


def _mid(entry, default=None):
    if entry and entry.get("mid") is not None:
        return float(entry["mid"])
    return default


def des_drug_budget(area_cm2, coating_um, density_g_cm3, drug_fraction,
                    loading_ug_cm2, oral_mg_per_day, months):
    """涂层支架的载药量预算：与口服日剂量/长期疗程对比，判断"系统性慢病"是否成立。"""
    coating_mg = area_cm2 * (coating_um / 1e4) * density_g_cm3 * 1000.0
    drug_from_coating_ug = coating_mg * drug_fraction * 1000.0
    drug_from_loading_ug = area_cm2 * loading_ug_cm2
    nominal_ug = min(drug_from_coating_ug, drug_from_loading_ug) if drug_from_loading_ug > 0 else drug_from_coating_ug
    days = max(months, 1e-9) * 30.0
    avg_ug_day = nominal_ug / days
    equivalent_days = (nominal_ug / 1000.0) / oral_mg_per_day
    ratio_to_oral = (avg_ug_day / 1000.0) / oral_mg_per_day
    return {
        "area_cm2": area_cm2,
        "coating_um": coating_um,
        "coating_mg": coating_mg,
        "drug_from_coating_ug": drug_from_coating_ug,
        "drug_from_loading_ug": drug_from_loading_ug,
        "nominal_drug_ug": nominal_ug,
        "release_months": months,
        "average_daily_ug": avg_ug_day,
        "equivalent_oral_days": equivalent_days,
        "ratio_to_daily_oral_dose": ratio_to_oral,
        "chronic_systemic_verdict": (
            "不成立：比口服日剂量低 3 个数量级以上" if ratio_to_oral < 1e-3
            else "量级接近，需要进一步药代动力学论证"),
        "local_delivery_note": "局部抗炎/抗再狭窄剂量在 DES 量级（µg–几百 µg），但这是已上市器械的既有逻辑",
    }


def pressure_load(defect_mm, pressure_mmhg, safety_factor):
    area_mm2 = math.pi * (defect_mm / 2.0) ** 2
    pressure_pa = pressure_mmhg * 133.322
    load_n = pressure_pa * area_mm2 * 1e-6
    return {
        "defect_mm": defect_mm,
        "area_mm2": area_mm2,
        "pressure_pa": pressure_pa,
        "static_load_n": load_n,
        "static_load_mn": load_n * 1000.0,
        "required_sealing_force_n": load_n * safety_factor,
        "required_sealing_force_mn": load_n * safety_factor * 1000.0,
        "safety_factor": safety_factor,
    }


def ring_radial_force(E_gpa, thickness_um, vessel_radius_mm, oversize_fraction, length_mm):
    """连续薄环近似下的径向力（N；数量级用，真实晶格需乘几何系数）。"""
    k_line = (E_gpa * 1e9) * (thickness_um * 1e-6) ** 3 / (12.0 * (vessel_radius_mm * 1e-3) ** 3)
    delta_r_m = oversize_fraction * vessel_radius_mm * 1e-3
    force_n = k_line * delta_r_m * (length_mm * 1e-3)
    return k_line, force_n


def degradation_class(months_mid):
    if months_mid is None:
        return "无降解动力学数据"
    if months_mid < HEALING_WINDOW_MONTHS[0]:
        return "过快（可能早于愈合）"
    if months_mid <= 12.0:
        return "匹配临时封堵/愈合窗（3–12 月）"
    return "偏慢，适合永久封堵/长期支撑"


def concept_material_screen(materials, vessel_radius_mm, frame_um, oversize, length_mm,
                            required_force_n):
    rows = []
    for material in materials:
        E = _mid(material["modulus"])
        if E is None:
            continue
        k_line, force_n = ring_radial_force(E, frame_um, vessel_radius_mm, oversize, length_mm)
        months = _mid(material["mass_loss"])
        rows.append({
            "id": material["id"],
            "name": material["name"],
            "family": material["family"],
            "E_gPa": E,
            "thickness_um": frame_um,
            "k_line_N_m2": k_line,
            "radial_force_n": force_n,
            "oversize_fraction": oversize,
            "mass_loss_months": months,
            "degradation_class": degradation_class(months),
            "force_margin": force_n / required_force_n if required_force_n > 0 else None,
        })
    rows.sort(key=lambda row: row["radial_force_n"], reverse=True)
    return rows


def cmd_concept(args):
    materials, summary_path, detail_path = load_materials()
    budget = des_drug_budget(
        args.area_cm2, args.coating_um, args.density, args.drug_frac,
        args.loading_ug_cm2, args.oral_mg, args.months,
    )
    vessel_radius_mm = args.vessel_mm / 2.0
    load = pressure_load(args.lesion_mm, args.pressure_mmhg, args.safety)
    screen = concept_material_screen(
        materials, vessel_radius_mm, args.frame_um, args.oversize,
        args.length_mm, load["required_sealing_force_n"],
    )
    for row in screen:
        row["suitable_permanent_occlusion"] = (
            row["force_margin"] is not None and row["force_margin"] >= 1.5
            and (row["mass_loss_months"] is None or row["mass_loss_months"] >= 12.0))
        row["suitable_temporary_sealing"] = (
            row["force_margin"] is not None and row["force_margin"] >= 1.5
            and row["mass_loss_months"] is not None
            and HEALING_WINDOW_MONTHS[0] <= row["mass_loss_months"] <= 12.0)
    permanent = [row["name"] for row in screen if row["suitable_permanent_occlusion"]]
    temporary = [row["name"] for row in screen if row["suitable_temporary_sealing"]]

    recommendation = {
        "primary": "concept B（封堵/栓塞器件：先区分『封堵但保通畅』与『断流栓塞』）",
        "concept_a_verdict": budget["chronic_systemic_verdict"],
        "concept_b_requirement": "缺损 {} mm、{} mmHg 下的静压载荷 {:.1f} mN；密封力至少 {:.1f} mN（安全系数 {}）".format(
            args.lesion_mm, args.pressure_mmhg, load["static_load_mn"],
            load["required_sealing_force_mn"], args.safety),
        "permanent_occlusion_shortlist": permanent,
        "temporary_sealing_shortlist": temporary,
        "note": "短名单只是连续薄环近似下的量级筛选；真实晶格/织物结构需乘几何系数并由台架校准",
    }
    limitations = [
        "连续薄环径向力是数量级近似，不是成品封堵器/支架的径向力",
        "材料库只有基础物性：金属无腐蚀动力学，聚合物只有近似完全吸收时间",
        "肿瘤位置/影像输入只作为病例上下文，本工具不做影像分割或病灶识别",
        "本工具不构成临床结论；封堵/栓塞的适应证、器械尺寸与手术方式须由医生决定",
        "DES 载药量按涂层体积/单位面积载药两种口径估算，实际取决于配方与工艺",
    ]

    if args.json:
        print(json.dumps({
            "command": "concept",
            "version": VERSION,
            "case": {
                "tumor_location": args.location,
                "lesion_mm": args.lesion_mm,
                "vessel_mm": args.vessel_mm,
                "length_mm": args.length_mm,
                "pressure_mmhg": args.pressure_mmhg,
                "flow_ml_min": args.flow_ml_min,
            },
            "concept_a_drug_eluting": budget,
            "concept_b_occluder": {
                "pressure_load": load,
                "frame_thickness_um": args.frame_um,
                "oversize_fraction": args.oversize,
                "material_screen": screen,
                "permanent_occlusion_shortlist": permanent,
                "temporary_sealing_shortlist": temporary,
            },
            "recommendation": recommendation,
            "limitations": limitations,
            "data_files": [str(summary_path.name), str(detail_path.name)],
        }, ensure_ascii=False, indent=2))
        return 0

    print("概念筛选：药物涂层支架（A） vs 封堵/栓塞器件（B）")
    print("病例输入：肿瘤位置={}；病变/缺损={} mm；目标血管={} mm；长度={} mm；血压={} mmHg；流量={} mL/min".format(
        args.location, args.lesion_mm, args.vessel_mm, args.length_mm, args.pressure_mmhg, args.flow_ml_min))
    print("")
    print("[A. 药物涂层支架：载药预算]")
    print("  表面积 {} cm2，涂层 {} um，涂层质量 {:.3f} mg".format(
        budget["area_cm2"], budget["coating_um"], budget["coating_mg"]))
    print("  载药量：按涂层/药物分数 {:.1f} ug；按单位面积载药 {:.1f} ug；取 {:.1f} ug".format(
        budget["drug_from_coating_ug"], budget["drug_from_loading_ug"], budget["nominal_drug_ug"]))
    print("  与口服 {:.0f} mg/day 等效：{:.4f} 天（{:.1f} 分钟）".format(
        args.oral_mg, budget["equivalent_oral_days"], budget["equivalent_oral_days"] * 24 * 60))
    print("  {} 个月平均释放 {:.3f} ug/day，相对口服日剂量 {:.5f}%".format(
        budget["release_months"], budget["average_daily_ug"], budget["ratio_to_daily_oral_dose"] * 100))
    print("  判定：{}".format(budget["chronic_systemic_verdict"]))
    print("")
    print("[B. 封堵/栓塞器件：压力载荷与材料筛选]")
    print("  缺损 {} mm -> 面积 {:.2f} mm2，静压载荷 {:.1f} mN；安全系数 {} 需 {:.1f} mN 密封力".format(
        load["defect_mm"], load["area_mm2"], load["static_load_mn"],
        load["safety_factor"], load["required_sealing_force_mn"]))
    print("  连续薄环近似：R={} mm，框厚 {} um，过盈 {:.0%}，长度 {} mm".format(
        vessel_radius_mm, args.frame_um, args.oversize, args.length_mm))
    rows = []
    for row in screen:
        rows.append([
            row["name"][:34], _num(row["E_gPa"]), _num(row["radial_force_n"], sig=4),
            _num(row["force_margin"], sig=3),
            ("{:.0f}".format(row["mass_loss_months"]) if row["mass_loss_months"] is not None else "-"),
            row["degradation_class"],
        ])
    _print_table(["材料", "E(GPa)", "径向力(N)", "力裕度", "吸收(月)", "降解分类"], rows,
                 aligns=["l", "r", "r", "r", "r", "l"])
    print("")
    print("  永久封堵短名单：{}".format("、".join(permanent) if permanent else "（无材料同时满足力裕度≥1.5 与吸收≥12 月）"))
    print("  临时封堵短名单：{}".format("、".join(temporary) if temporary else "（无材料同时满足力裕度≥1.5 与 3–12 月吸收）"))
    print("")
    print("[建议]")
    print("  主方向：{}".format(recommendation["primary"]))
    print("  A 判定：{}".format(recommendation["concept_a_verdict"]))
    print("  B 约束：{}".format(recommendation["concept_b_requirement"]))
    print("  说明：{}".format(recommendation["note"]))
    print("")
    print("[限制]")
    for item in limitations:
        print("  - {}".format(item))
    return 0


# --------------------------------------------------------------------------
# 命令：fdo —— FDO 数据集聚合物降解/材料物理指标筛选
# --------------------------------------------------------------------------

# 常数来自 FDO dataset 2026-10-21 的 src/degradation.py：
# 文献量级占位（不是拟合值），演示时必须标注“screening, not measured”。
FDO_POLYMERS = [
    # name, mw0_kDa, k_per_day, alpha, mw_crit_kDa, mode, release_n, burst, swell_percent
    ("PLGA 50:50", 60.0, 0.012, 1.5, 10.0, "bulk", 0.45, 0.12, 8.0),
    ("PLGA 85:15", 70.0, 0.0040, 1.5, 10.0, "bulk", 0.45, 0.10, 5.0),
    ("PCL", 80.0, 0.0007, 0.0, 10.0, "bulk", 0.45, 0.05, 2.0),
    ("poly(ortho ester)", 50.0, 0.0060, 0.0, 10.0, "surface", 0.95, 0.03, 1.0),
    ("polyanhydride", 45.0, 0.0150, 0.0, 10.0, "surface", 1.00, 0.02, 0.0),
]
FDO_SOURCE = "FDO dataset 2026-10-21 · src/degradation.py（literature-order placeholders, not fitted）"


def _fdo_mw_fraction(t_days, k, alpha):
    a = 1.0 + alpha
    e = math.exp(-k * a * t_days)
    return a * e / (1.0 + alpha * e)


def _fdo_time_to_mw_fraction(x_target, k, alpha):
    if x_target <= 0:
        return float("inf")
    if x_target >= 1:
        return 0.0
    a = 1.0 + alpha
    denom = a - alpha * x_target
    if denom <= 0:
        return float("inf")
    return math.log(denom / x_target) / (k * a)


def _fdo_mass_loss(t_days, polymer):
    _, mw0, k, alpha, mw_crit, mode, _, _, _ = polymer
    if mode == "surface":
        return min(1.0, k * t_days)
    t_crit = _fdo_time_to_mw_fraction(mw_crit / mw0, k, alpha)
    if not math.isfinite(t_crit) or t_days <= t_crit:
        return 0.0
    tau = max(1.0, 0.15 * t_crit)
    return 1.0 - math.exp(-(t_days - t_crit) / tau)


def _fdo_radius_drift(r0_mm, mass_loss, swell_percent, outer_ratio=1.5):
    r_out = outer_ratio * r0_mm
    r = math.sqrt(max(0.0, r_out ** 2 - (1.0 - mass_loss) * (r_out ** 2 - r0_mm ** 2)))
    r *= (1.0 - swell_percent / 100.0)
    return (r - r0_mm) / r0_mm


def _fdo_screen(polymer, release_days, horizon_days, r0_mm, tolerance):
    name, mw0, k, alpha, mw_crit, mode, n, burst, swell = polymer
    t_crit = (1.0 / k if mode == "surface"
              else _fdo_time_to_mw_fraction(mw_crit / mw0, k, alpha))
    ml_rel = _fdo_mass_loss(release_days, polymer)
    ml_h = _fdo_mass_loss(horizon_days, polymer)
    dr_rel = _fdo_radius_drift(r0_mm, ml_rel, swell)
    dr_h = _fdo_radius_drift(r0_mm, ml_h, swell)
    return {
        "polymer": name,
        "mode": mode,
        "t_crit_days": t_crit,
        "mass_loss_at_release_end": ml_rel,
        "mass_loss_at_horizon": ml_h,
        "radius_drift_at_release_end": dr_rel,
        "radius_drift_at_horizon": dr_h,
        "release_order_n": n,
        "burst_fraction": burst,
        "meets_orifice_tolerance": abs(dr_h) <= tolerance,
        "meets_zero_order": n >= 0.85,
    }


def cmd_fdo(args):
    release_days = args.release_days
    horizon_days = args.horizon_days
    orifice_mm = args.orifice_mm
    tolerance = args.tolerance
    r0_mm = orifice_mm / 2.0
    rows = [_fdo_screen(p, release_days, horizon_days, r0_mm, tolerance) for p in FDO_POLYMERS]
    both = [r["polymer"] for r in rows if r["meets_orifice_tolerance"] and r["meets_zero_order"]]
    neither = [r["polymer"] for r in rows if not r["meets_orifice_tolerance"] and not r["meets_zero_order"]]
    limitations = [
        "动力学常数是文献量级占位（不是拟合值）：只用于 screening，不能当实测寿命。",
        "模型只含水解/质量损失/孔径漂移/释放指数，不含 pH、血栓、疲劳、灭菌影响。",
        "孔口漂移按“平板内孔 + 1.5 倍外径”几何近似；真实器件需台架/动物验证。",
        "输出是材料短名单与物理指标，不构成器械尺寸或临床决策。",
    ]

    if args.json:
        print(json.dumps({
            "command": "fdo",
            "params": {"release_days": release_days, "horizon_days": horizon_days,
                       "orifice_mm": orifice_mm, "tolerance": tolerance},
            "polymers": rows,
            "summary": {"meets_both": both, "fails_both": neither,
                        "conclusion": ("无单一聚合物同时满足孔口容差与零级释放" if not both
                                       else "满足双约束的候选：" + "、".join(both))},
            "source": FDO_SOURCE,
            "limitations": limitations,
        }, ensure_ascii=False, indent=2))
        return 0

    print("FDO 材料物理指标筛选（screening, not measured）")
    print("需求：释放窗口 {} 天；服役期 {} 天；孔口直径 {} mm（容差 ±{:.0%}）".format(
        _num(release_days), _num(horizon_days), _num(orifice_mm), tolerance))
    print("数据源：{}".format(FDO_SOURCE))
    print("")
    table = []
    for r in rows:
        table.append([
            r["polymer"], r["mode"], _num(r["t_crit_days"], sig=4),
            _num(r["mass_loss_at_release_end"], sig=3), _num(r["mass_loss_at_horizon"], sig=3),
            "{:+.1%}".format(r["radius_drift_at_release_end"]),
            "{:+.1%}".format(r["radius_drift_at_horizon"]),
            _num(r["release_order_n"], sig=2),
            ("孔口OK" if r["meets_orifice_tolerance"] else "孔口FAILS") + "/" +
            ("零级" if r["meets_zero_order"] else "一级"),
        ])
    _print_table(["polymer", "mode", "t_crit(d)", "ml@rel", "ml@horizon",
                  "dr@rel", "dr@horizon", "n", "verdict"], table,
                 aligns=["l", "l", "r", "r", "r", "r", "r", "r", "l"])
    print("")
    if both:
        print("双约束都满足：{}".format("、".join(both)))
    else:
        print("结论：无单一聚合物同时满足「孔口 ±{:.0%}」与「零级释放 n≥0.85」——需求单本身过约束。".format(tolerance))
        print("可行方向：拆功能（不降解孔口 + 独立降解药库）/ 放宽零级要求 / 缩短服役期。")
    print("")
    print("[限制]")
    for item in limitations:
        print("  - {}".format(item))
    return 0


# --------------------------------------------------------------------------
# argparse 入口
# --------------------------------------------------------------------------

def _positive_float(text):
    try:
        value = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError("需要数值，收到 {!r}".format(text))
    if not math.isfinite(value):
        raise argparse.ArgumentTypeError("需要有限数值，收到 {!r}".format(text))
    return value


def build_parser():
    parser = argparse.ArgumentParser(
        prog="stent_tool.py",
        description="可吸收血管支架域包工具：材料对比 / 泊肃叶基准 / 薄环尺度 / 数值实现自检（纯标准库）",
        epilog="示例：python stent_tool.py verify --n 20,320 --json；"
               "python stent_tool.py flow --q 20 40 100 --json",
    )
    parser.add_argument("--version", action="version", version="stent_tool.py {}".format(VERSION))
    subparsers = parser.add_subparsers(dest="command", metavar="<command>")

    p_mat = subparsers.add_parser("materials", help="材料对比表（读 data/ 下两个 CSV）")
    p_mat.add_argument("--family", choices=("Mg", "Zn", "Fe", "polymer"),
                       help="按材料族过滤")
    p_mat.add_argument("--degradable", action="store_true",
                       help="只保留数据集中有完全质量损失时间的材料（可吸收/降解口径）")
    p_mat.add_argument("--min-tensile", type=_positive_float, default=None, metavar="MPa",
                       help="最小抗拉强度（按区间中点比较；无数据者排除）")
    p_mat.add_argument("--sort", choices=("E", "tensile", "name"), default=None,
                       help="排序键：E（弹性模量）或 tensile（抗拉）或 name")
    p_mat.add_argument("--asc", action="store_true", help="升序（默认数值降序）")
    p_mat.add_argument("--json", action="store_true", help="只输出一个 JSON 对象")
    p_mat.set_defaults(func=cmd_materials)

    p_ring = subparsers.add_parser("ring", help="连续薄环刚度尺度 k_line = E t^3/(12 R^3)")
    p_ring.add_argument("--E", type=_positive_float, required=True, metavar="GPa",
                        help="弹性模量（GPa）")
    p_ring.add_argument("--t", type=_positive_float, required=True, metavar="um",
                        help="环壁厚（μm）")
    p_ring.add_argument("--R", type=_positive_float, default=R_MM_DEFAULT, metavar="mm",
                        help="环半径（mm，默认 1.5）")
    p_ring.add_argument("--displacement", action="append", default=None, metavar="mm",
                        help="径向位移（mm，可重复或用逗号分隔；默认 0.1 0.2）")
    p_ring.add_argument("--material", default="", help="材料名（仅用于标注输出）")
    p_ring.add_argument("--json", action="store_true", help="只输出一个 JSON 对象")
    p_ring.set_defaults(func=cmd_ring)

    p_flow = subparsers.add_parser("flow", help="圆管泊肃叶解析基准")
    p_flow.add_argument("--q", type=_positive_float, nargs="+", default=None, metavar="ml/min",
                        help="流量（mL/min，可多个；默认 100）")
    p_flow.add_argument("--R", type=_positive_float, default=R_MM_DEFAULT, metavar="mm",
                        help="管半径（mm，默认 1.5）")
    p_flow.add_argument("--L", type=_positive_float, default=L_MM_DEFAULT, metavar="mm",
                        help="管长（mm，默认 18）")
    p_flow.add_argument("--rho", type=_positive_float, default=RHO_DEFAULT, metavar="kg/m3",
                        help="密度（kg/m³，默认 1025）")
    p_flow.add_argument("--mu", type=_positive_float, default=MU_DEFAULT, metavar="Pa·s",
                        help="动力黏度（Pa·s，默认 1.5e-3）")
    p_flow.add_argument("--json", action="store_true", help="只输出一个 JSON 对象")
    p_flow.set_defaults(func=cmd_flow)

    p_con = subparsers.add_parser(
        "concept",
        help="概念筛选：药物涂层支架（A） vs 封堵/栓塞器件（B），按病例输入给材料建议",
    )
    p_con.add_argument("--location", default="未指定", help="肿瘤/病变位置（病例上下文，只回显）")
    p_con.add_argument("--lesion-mm", type=_positive_float, default=4.0, metavar="mm",
                       help="病变/缺损直径（mm，默认 4）")
    p_con.add_argument("--vessel-mm", type=_positive_float, default=3.0, metavar="mm",
                       help="目标血管直径（mm，默认 3）")
    p_con.add_argument("--length-mm", type=_positive_float, default=10.0, metavar="mm",
                       help="封堵段/病变长度（mm，默认 10）")
    p_con.add_argument("--pressure-mmhg", type=_positive_float, default=100.0, metavar="mmHg",
                       help="血压（默认 100 mmHg）")
    p_con.add_argument("--flow-ml-min", type=_positive_float, default=100.0, metavar="ml/min",
                       help="流量（默认 100 mL/min，仅回显/后续 FSI）")
    p_con.add_argument("--area-cm2", type=_positive_float, default=1.5, metavar="cm2",
                       help="涂层表面积（默认 1.5 cm2）")
    p_con.add_argument("--coating-um", type=_positive_float, default=5.0, metavar="um",
                       help="涂层厚度（μm，默认 5）")
    p_con.add_argument("--density", type=_positive_float, default=1.2, metavar="g/cm3",
                       help="涂层密度（g/cm3，默认 1.2）")
    p_con.add_argument("--drug-frac", type=_positive_float, default=0.30,
                       help="药物质量分数（默认 0.30）")
    p_con.add_argument("--loading-ug-cm2", type=_positive_float, default=100.0, metavar="ug/cm2",
                       help="单位面积载药（默认 100 µg/cm2，DES 量级）")
    p_con.add_argument("--oral-mg", type=_positive_float, default=20.0, metavar="mg",
                       help="对照口服日剂量（默认 20 mg/day）")
    p_con.add_argument("--months", type=_positive_float, default=18.0, metavar="月",
                       help="释放/疗程时长（默认 18 月）")
    p_con.add_argument("--frame-um", type=_positive_float, default=150.0, metavar="um",
                       help="封堵器框/支架厚度（默认 150 μm）")
    p_con.add_argument("--oversize", type=_positive_float, default=0.15,
                       help="径向过盈比例（默认 0.15）")
    p_con.add_argument("--safety", type=_positive_float, default=2.0,
                       help="密封安全系数（默认 2）")
    p_con.add_argument("--json", action="store_true", help="只输出一个 JSON 对象")
    p_con.set_defaults(func=cmd_concept)

    p_fdo = subparsers.add_parser(
        "fdo",
        help="FDO 材料物理指标筛选：t_crit / 质量损失 / 孔径漂移 / 释放指数（文献量级占位）",
    )
    p_fdo.add_argument("--release-days", type=_positive_float, default=7.0, metavar="天",
                       help="释放窗口（默认 7 天）")
    p_fdo.add_argument("--horizon-days", type=_positive_float, default=90.0, metavar="天",
                       help="服役期（默认 90 天）")
    p_fdo.add_argument("--orifice-mm", type=_positive_float, default=0.71, metavar="mm",
                       help="孔口直径（默认 0.71 mm，来自 FDO 设计扫描）")
    p_fdo.add_argument("--tolerance", type=_positive_float, default=0.10,
                       help="孔口半径容差（默认 0.10 = ±10%）")
    p_fdo.add_argument("--json", action="store_true", help="只输出一个 JSON 对象")
    p_fdo.set_defaults(func=cmd_fdo)

    p_ver = subparsers.add_parser("verify", help="纯 Python 三对角求解的数值实现自检")
    p_ver.add_argument("--n", nargs="+", default=None,
                       metavar="N", help="网格节点数（可逗号分隔；默认 20,40,80,160,320）")
    p_ver.add_argument("--pipe", action="store_true", help="只跑圆管有限差分")
    p_ver.add_argument("--cylinder", action="store_true", help="只跑轴对称厚壁圆筒")
    p_ver.add_argument("--json", action="store_true", help="只输出一个 JSON 对象")
    p_ver.set_defaults(func=cmd_verify)

    p_all = subparsers.add_parser("all", help="flow(20..200) + verify + ring 的 provenance JSON")
    p_all.add_argument("--json", action="store_true", help="只输出一个 JSON 对象")
    p_all.set_defaults(func=cmd_all)

    return parser


def main(argv=None):
    _setup_stdout()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help(sys.stderr)
        return 2
    try:
        return args.func(args)
    except FileNotFoundError as exc:
        _fatal("文件缺失：{}".format(exc))
    except PermissionError as exc:
        _fatal("文件不可读：{}".format(exc))
    except (ValueError, ZeroDivisionError) as exc:
        _fatal("计算失败：{}".format(exc))
    return 0


if __name__ == "__main__":
    sys.exit(main())


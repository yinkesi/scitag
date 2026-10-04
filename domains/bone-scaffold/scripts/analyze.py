#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
analyze.py —— 骨支架数据集分析脚本（bone-scaffold 域包内置，供 agent 宿主直接执行）

用法（在本仓库根目录）：
  python3 domains/bone-scaffold/scripts/analyze.py stats
  python3 domains/bone-scaffold/scripts/analyze.py fit [--by vf|angle]
  python3 domains/bone-scaffold/scripts/analyze.py inverse --target 8e-11

依赖：openpyxl（读 xlsx）。数值部分纯 Python（最小二乘 = 正规方程 + 高斯消元，
无 numpy 依赖，任何 Python3.8+ 都能跑）。

口径提醒：permeability 在本数据集事实恒定（相对离散 8.5e-8），本脚本一律不拟合它。
"""
import argparse
import json
import os
import sys

try:
    import openpyxl
except ImportError:
    print("需要 openpyxl：pip install openpyxl", file=sys.stderr)
    sys.exit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
XLSX = os.path.join(HERE, "..", "data", "BONE_SCAFFOLD.xlsx")


def load_rows():
    wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    hdr_i = next(i for i, r in enumerate(rows) if r and r[0] == "IMAGE_ID")
    out = []
    for r in rows[hdr_i + 1:]:
        if not r or not r[0]:
            continue
        out.append({
            "id": r[0], "vf": float(r[1]), "ang": float(r[2]), "tvf": float(r[3]),
            "fw": float(r[4]), "comp": float(r[5]), "perm": float(r[6]),
        })
    return out


# ---------- 纯 Python 最小二乘 ----------

def solve(A, b):
    """高斯消元（部分主元）解线性方程组 A x = b。"""
    n = len(A)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        if abs(M[piv][col]) < 1e-300:
            raise ValueError("奇异矩阵（设计矩阵列共线）")
        M[col], M[piv] = M[piv], M[col]
        for r in range(col + 1, n):
            f = M[r][col] / M[col][col]
            for c in range(col, n + 1):
                M[r][c] -= f * M[col][c]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        s = M[r][n] - sum(M[r][c] * x[c] for c in range(r + 1, n))
        x[r] = s / M[r][r]
    return x


def lstsq(rows_X, y):
    """最小二乘：rows_X 设计矩阵行列表，y 响应。返回 (beta, r2, rmse)。"""
    k = len(rows_X[0])
    ata = [[sum(r[a] * r[b] for r in rows_X) for b in range(k)] for a in range(k)]
    aty = [sum(r[a] * yy for r, yy in zip(rows_X, y)) for a in range(k)]
    beta = solve(ata, aty)
    yhat = [sum(b * v for b, v in zip(beta, r)) for r in rows_X]
    ybar = sum(y) / len(y)
    ss_res = sum((yy - hh) ** 2 for yy, hh in zip(y, yhat))
    ss_tot = sum((yy - ybar) ** 2 for yy in y)
    r2 = 1 - ss_res / ss_tot if ss_tot else float("nan")
    rmse = (ss_res / len(y)) ** 0.5
    return beta, r2, rmse


MODELS = {
    "M1 线性 c~1+vf+ang":        lambda d: [1.0, d["vf"], d["ang"]],
    "M2 二次 +vf²+ang²":         lambda d: [1.0, d["vf"], d["ang"], d["vf"] ** 2, d["ang"] ** 2],
    "M3 交互 M2+vf*ang":         lambda d: [1.0, d["vf"], d["ang"], d["vf"] ** 2, d["ang"] ** 2, d["vf"] * d["ang"]],
}


def fmt_coef(names, beta):
    return "  " + " + ".join(f"{c:.4g}·{n}" if n != "1" else f"{c:.4g}"
                            for c, n in zip(beta, names))


def cmd_stats(rows):
    vfs = sorted({r["vf"] for r in rows}); angs = sorted({r["ang"] for r in rows})
    comp = [r["comp"] for r in rows]; perm = [r["perm"] for r in rows]
    print(f"行数 {len(rows)}；Vf {len(vfs)} 档 [{vfs[0]}, {vfs[-1]}]；角度 {len(angs)} 档 [{angs[0]}°, {angs[-1]}°]")
    print(f"全因子网格：{len(vfs)}×{len(angs)} = {len(vfs)*len(angs)}（{'完整' if len(vfs)*len(angs)==len(rows) else '不完整！'}）")
    print(f"compliance：min {min(comp):.4g}  max {max(comp):.4g}  跨度 {max(comp)/min(comp):.1f}×")
    print(f"permeability：min {min(perm):.12g}  max {max(perm):.12g}  相对离散 {(max(perm)-min(perm))/min(perm):.2e}（事实恒定，勿当响应变量）")
    print(f"Target vf == vf：{'全部一致' if all(abs(r['tvf']-r['vf'])<1e-9 for r in rows) else '存在偏差'}")
    print(f"Fluid weight 唯一值：{sorted({r['fw'] for r in rows})}")


def grouped(rows, key, other):
    ks = sorted({r[key] for r in rows})
    print(f"固定 {key} 扫 {other}（compliance）：")
    for k in ks:
        sub = sorted([r for r in rows if r[key] == k], key=lambda r: r[other])
        vals = [r["comp"] for r in sub]
        print(f"  {key}={k:g}: {other} {sub[0][other]:g}°→{vals[0]:.3g}  {sub[-1][other]:g}°→{vals[-1]:.3g}"
              f"  {'单调↑' if vals[-1]>vals[0] else '单调↓'}  倍数 {max(vals)/min(vals):.2f}×")


def cmd_fit(rows, by=None):
    if by:
        key, other = ("vf", "ang") if by == "vf" else ("ang", "vf")
        return grouped(rows, key, other)
    y = [r["comp"] for r in rows]
    names_sets = {
        "M1 线性 c~1+vf+ang": ["1", "vf", "ang"],
        "M2 二次 +vf²+ang²": ["1", "vf", "ang", "vf²", "ang²"],
        "M3 交互 M2+vf*ang": ["1", "vf", "ang", "vf²", "ang²", "vf·ang"],
    }
    best = None
    for label, feat in MODELS.items():
        X = [feat(d) for d in rows]
        beta, r2, rmse = lstsq(X, y)
        print(f"{label}\n  R²={r2:.5f}  RMSE={rmse:.3g}\n  c ≈{fmt_coef(names_sets[label], beta)}")
        if best is None or r2 > best[1]:
            best = (label, r2)
    # 对数空间复核（指数趋势探测）
    import math
    ly = [math.log(v) for v in y]
    label = "M4 log(c)~1+vf+ang（指数趋势）"
    X = [MODELS["M1 线性 c~1+vf+ang"](d) for d in rows]
    beta, r2, rmse = lstsq(X, ly)
    print(f"{label}\n  R²={r2:.5f}（log 域）\n  c ≈ exp({fmt_coef(['1','vf','ang'], beta)})")
    print(f"\n最简充分模型建议：见上表按「R² 提升 <2% 不加项」取舍；适用域 Vf∈[0.25,0.65]、θ∈[0°,45°]（数据凸包）")


def cmd_inverse(rows, target):
    comp = [r["comp"] for r in rows]
    lo, hi = min(comp), max(comp)
    if target < lo:
        print(f"目标 {target:.3g} 低于数据域最小 compliance {lo:.3g}：数据域内无解（外推需补仿真，拒绝硬给）。")
        return
    feas = [r for r in rows if r["comp"] <= target]
    if not feas:
        print(f"目标 {target:.3g} 高于数据域最大值 {hi:.3g}：全部 100 行都满足（约束无意义，请收紧）。")
        return
    print(f"目标：compliance ≤ {target:.3g}；可行 {len(feas)}/100 行")
    by_vf = {}
    by_ang = {}
    for r in feas:
        by_vf.setdefault(r["vf"], []).append(r["ang"])
        by_ang.setdefault(r["ang"], []).append(r["vf"])
    print("按 Vf 的可行角度区间：")
    for vf in sorted(by_vf):
        angs = sorted(by_vf[vf])
        print(f"  Vf={vf:g}: θ∈[{angs[0]:g}°, {angs[-1]:g}°]（{len(angs)} 档可行）")
    print("按角度的可行 Vf 区间：")
    for ang in sorted(by_ang):
        vfs = sorted(by_ang[ang])
        print(f"  θ={ang:g}°: Vf∈[{vfs[0]:.3f}, {vfs[-1]:.3f}]（{len(vfs)} 档可行）")
    best = min(feas, key=lambda r: r["comp"])
    print(f"最刚可行设计：{best['id']}（Vf={best['vf']:g}, θ={best['ang']:g}°, c={best['comp']:.3g}）")
    print("提示：可行域仅在本数据凸包内有效（Fluid weight 恒 1e5 口径）；多解时注意 Vf↑ 牺牲孔隙的权衡。")


def main():
    ap = argparse.ArgumentParser(description="骨支架数据集分析（stats/fit/inverse）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("stats")
    f = sub.add_parser("fit"); f.add_argument("--by", choices=["vf", "angle"])
    iv = sub.add_parser("inverse"); iv.add_argument("--target", type=float, required=True)
    a = ap.parse_args()
    rows = load_rows()
    if not rows:
        sys.exit("数据集为空")
    if a.cmd == "stats":
        cmd_stats(rows)
    elif a.cmd == "fit":
        cmd_fit(rows, by="vf" if a.by == "vf" else ("ang" if a.by == "angle" else None))
    elif a.cmd == "inverse":
        cmd_inverse(rows, a.target)


if __name__ == "__main__":
    main()

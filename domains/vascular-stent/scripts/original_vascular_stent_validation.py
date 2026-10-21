from __future__ import annotations

import csv
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent
OUT_DIR = ROOT
WORK_DIR = ROOT / "stent_model_validation_artifacts"
FIG_DIR = WORK_DIR / "figures"
RESULT_CSV = OUT_DIR / "血管支架物理模型验证结果_2026-10-18.csv"
SUMMARY_JSON = WORK_DIR / "stent_model_validation_summary.json"

OUT_DIR.mkdir(parents=True, exist_ok=True)
FIG_DIR.mkdir(parents=True, exist_ok=True)

FONT_PATH = Path(r"C:\Windows\Fonts\msyh.ttc")
FONT_BOLD_PATH = Path(r"C:\Windows\Fonts\msyhbd.ttc")
NAVY = "#173B57"
TEAL = "#2F7D7E"
ORANGE = "#C76B2A"
INK = "#1A1A1A"
MUTED = "#5B6570"
GRID = "#D9D9D9"
PALE = "#EAF2F7"
WHITE = "#FFFFFF"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONT_BOLD_PATH if bold else FONT_PATH), size)


def draw_arrow(draw: ImageDraw.ImageDraw, start: tuple[int, int], end: tuple[int, int],
               fill: str, width: int = 5) -> None:
    draw.line([start, end], fill=fill, width=width)
    angle = math.atan2(end[1] - start[1], end[0] - start[0])
    length = 16
    spread = math.pi / 7
    p1 = (
        end[0] - length * math.cos(angle - spread),
        end[1] - length * math.sin(angle - spread),
    )
    p2 = (
        end[0] - length * math.cos(angle + spread),
        end[1] - length * math.sin(angle + spread),
    )
    draw.polygon([end, p1, p2], fill=fill)


def box(draw: ImageDraw.ImageDraw, bounds: tuple[int, int, int, int],
        title: str, body: str, fill: str) -> None:
    x0, y0, x1, y1 = bounds
    draw.rounded_rectangle(bounds, radius=20, fill=fill, outline=NAVY, width=3)
    draw.text((x0 + 22, y0 + 18), title, font=font(31, True), fill=INK)
    draw.multiline_text(
        (x0 + 22, y0 + 65),
        body,
        font=font(22),
        fill=INK,
        spacing=8,
    )


def draw_framework() -> Path:
    image = Image.new("RGB", (1800, 1040), WHITE)
    draw = ImageDraw.Draw(image)
    draw.text((70, 45), "血管支架多物理场模型", font=font(44, True), fill=INK)
    draw.text(
        (70, 105),
        "从器械展开到长期降解的耦合验证链",
        font=font(24),
        fill=MUTED,
    )
    draw.line([70, 150, 1730, 150], fill=NAVY, width=3)

    top = [
        ((80, 210, 510, 430), "1  几何与材料",
         "支架单元、血管与斑块\n材料参数、厚度、直径\n与降解状态", PALE),
        ((570, 210, 1000, 430), "2  展开与接触",
         "压握、球囊扩张\n回弹、短缩、狗骨形\n血管/斑块接触", "#F6EEE6"),
        ((1060, 210, 1490, 430), "3  心动周期 FSI",
         "脉动入口、Windkessel\n管壁变形、WSS\nTAWSS / OSI / RRT", "#E8F3F1"),
    ]
    for bounds, title, body, fill in top:
        box(draw, bounds, title, body, fill)
    for start, end in [((510, 320), (570, 320)), ((1000, 320), (1060, 320))]:
        draw_arrow(draw, start, end, NAVY)

    bottom = [
        ((80, 555, 510, 775), "4  长期降解",
         "腐蚀/水解前沿\n分子量、强度、质量损失\n支撑力退化和失效风险", "#F7F2E8"),
        ((570, 555, 1000, 775), "5  生物与血栓指标",
         "细胞活性、溶血\n凝血与补体\n体内组织反应", "#EEF1F8"),
        ((1060, 555, 1490, 775), "6  优化与代理模型",
         "多目标拓扑/形状优化\nPareto 前沿\nVAE/FEA 代理与复核", "#E8F3F1"),
    ]
    for bounds, title, body, fill in bottom:
        box(draw, bounds, title, body, fill)
    draw_arrow(draw, (1275, 430), (1275, 555), NAVY)
    draw_arrow(draw, (1060, 665), (1000, 665), NAVY)
    draw_arrow(draw, (570, 665), (510, 665), NAVY)

    draw.rounded_rectangle((1540, 210, 1730, 775), radius=18, fill=NAVY)
    draw.multiline_text(
        (1570, 290),
        "输出\n\n径向力\n\n回弹\n\n短缩\n\nWSS\n\n寿命\n\n生物学",
        font=font(20, True),
        fill=WHITE,
        spacing=10,
        align="center",
    )
    draw_arrow(draw, (1490, 320), (1540, 320), NAVY)
    draw_arrow(draw, (1490, 665), (1540, 665), NAVY)

    draw.rounded_rectangle((80, 840, 1490, 965), radius=18, fill="#F3F5F7",
                           outline=GRID, width=2)
    draw.text((105, 862), "验证闭环", font=font(28, True), fill=INK)
    draw.text(
        (245, 870),
        "解析解 -> 网格收敛 -> 同条件 3D 复算 -> 台架试验 -> 体外/体内试验",
        font=font(24),
        fill=INK,
    )
    path = FIG_DIR / "model-framework.png"
    image.save(path)
    return path


def draw_axes(draw: ImageDraw.ImageDraw, bounds: tuple[int, int, int, int],
              title: str, xlabel: str, ylabel: str) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = bounds
    if title:
        draw.text((x0, y0 - 42), title, font=font(26, True), fill=INK)
    draw.line((x0, y1, x1, y1), fill=INK, width=2)
    draw.line((x0, y0, x0, y1), fill=INK, width=2)
    draw.text(((x0 + x1) // 2 - len(xlabel) * 6, y1 + 48), xlabel,
              font=font(20), fill=MUTED)
    return x0, y0, x1, y1


def map_x(value: float, domain: tuple[float, float], plot: tuple[int, int, int, int]) -> float:
    x0, _, x1, _ = plot
    lo, hi = domain
    return x0 + (value - lo) / (hi - lo) * (x1 - x0)


def map_y(value: float, domain: tuple[float, float], plot: tuple[int, int, int, int]) -> float:
    _, y0, _, y1 = plot
    lo, hi = domain
    return y1 - (value - lo) / (hi - lo) * (y1 - y0)


def draw_flow_figure(flow_rows: list[dict[str, float]]) -> Path:
    image = Image.new("RGB", (1600, 900), WHITE)
    draw = ImageDraw.Draw(image)
    draw.text((70, 40), "参考冠状动脉窗口内的流量与剪切", font=font(40, True), fill=INK)
    draw.text((70, 100), "R = 1.5 mm, L = 18 mm, rho = 1025 kg/m3, mu = 1.5 mPa.s",
              font=font(21), fill=MUTED)

    q_values = [row["Q_ml_min"] for row in flow_rows]
    reynolds = [row["Re"] for row in flow_rows]
    wss = [row["WSS_Pa"] for row in flow_rows]

    p1 = (170, 220, 740, 690)
    p2 = (980, 220, 1510, 690)
    draw_axes(draw, p1, "雷诺数 Re", "流量 (mL/min)", "")
    draw_axes(draw, p2, "壁面剪切应力 WSS (Pa)", "流量 (mL/min)", "")

    for value in [50, 100, 150, 200]:
        for p in (p1, p2):
            x = map_x(value, (0, 210), p)
            draw.line((x, p[1], x, p[3]), fill=GRID, width=1)
            draw.text((x - 12, p[3] + 8), str(value), font=font(18), fill=MUTED)

    for value in [0, 250, 500, 750, 1000]:
        y = map_y(value, (0, 1000), p1)
        draw.line((p1[0], y, p1[2], y), fill=GRID, width=1)
        draw.text((p1[0] - 55, y - 12), str(value), font=font(18), fill=MUTED)
    for value in [0.0, 0.5, 1.0, 1.5, 2.0]:
        y = map_y(value, (0, 2.0), p2)
        draw.line((p2[0], y, p2[2], y), fill=GRID, width=1)
        draw.text((p2[0] - 43, y - 12), f"{value:.1f}", font=font(18), fill=MUTED)

    pts1 = [(map_x(q, (0, 210), p1), map_y(r, (0, 1000), p1)) for q, r in zip(q_values, reynolds)]
    pts2 = [(map_x(q, (0, 210), p2), map_y(w, (0, 2.0), p2)) for q, w in zip(q_values, wss)]
    draw.line(pts1, fill=TEAL, width=5, joint="curve")
    draw.line(pts2, fill=ORANGE, width=5, joint="curve")
    for q, r, w in zip(q_values, reynolds, wss):
        x1 = map_x(q, (0, 210), p1)
        y1 = map_y(r, (0, 1000), p1)
        x2 = map_x(q, (0, 210), p2)
        y2 = map_y(w, (0, 2.0), p2)
        draw.ellipse((x1 - 6, y1 - 6, x1 + 6, y1 + 6), fill=TEAL)
        draw.ellipse((x2 - 6, y2 - 6, x2 + 6, y2 + 6), fill=ORANGE)
        if q in (50, 100, 150):
            draw.text((x1 - 20, y1 - 34), f"{r:.0f}", font=font(17), fill=INK)
            draw.text((x2 - 24, y2 - 32), f"{w:.2f}", font=font(17), fill=INK)

    draw.rounded_rectangle((170, 780, 1510, 850), radius=14, fill=PALE)
    draw.text(
        (195, 803),
        "在 100 mL/min 基线流量下，Re 约 484、WSS 约 0.94 Pa；这是牛顿流体管线基准，不是患者阈值。",
        font=font(22),
        fill=INK,
    )
    path = FIG_DIR / "flow-window.png"
    image.save(path)
    return path


@dataclass
class StentMaterial:
    name: str
    modulus_gpa: float
    thickness_um: float
    note: str


def draw_stiffness_figure(materials: list[StentMaterial]) -> Path:
    image = Image.new("RGB", (1600, 840), WHITE)
    draw = ImageDraw.Draw(image)
    draw.text((70, 40), "连续薄环模型的径向刚度尺度", font=font(40, True), fill=INK)
    draw.text(
        (70, 100),
        "k_line = E t^3 / (12 R^3)，R = 1.5 mm；仅用于数量级核对，实际支架需乘几何系数并由台架校准",
        font=font(21),
        fill=MUTED,
    )
    plot = (150, 230, 1480, 690)
    draw_axes(draw, plot, "", "", "")
    vals = [
        material.modulus_gpa * 1e9 * (material.thickness_um * 1e-6) ** 3
        / (12 * (1.5e-3) ** 3)
        for material in materials
    ]
    max_value = max(vals) * 1.12
    for tick in [0.0, 0.5e6, 1.0e6, 1.5e6, 2.0e6]:
        if tick <= max_value:
            y = map_y(tick, (0, max_value), plot)
            draw.line((plot[0], y, plot[2], y), fill=GRID, width=1)
            draw.text((plot[0] - 62, y - 12), f"{tick / 1e6:.1f}",
                      font=font(17), fill=MUTED)
    draw.text((plot[0] - 8, plot[1] - 36), "k_line (x 10^6 N/m^2)",
              font=font(18), fill=MUTED)
    bar_width = 165
    gap = 90
    x = plot[0] + 75
    colors = [NAVY, TEAL, ORANGE, "#8A6D3B", "#567A57"]
    for idx, (material, value) in enumerate(zip(materials, vals)):
        y = map_y(value, (0, max_value), plot)
        color = colors[idx % len(colors)]
        draw.rounded_rectangle((x, y, x + bar_width, plot[3]), radius=10, fill=color)
        draw.text((x + 4, y - 36), f"{value / 1e6:.2f}", font=font(19, True), fill=INK)
        draw.text((x - 2, plot[3] + 20), material.name, font=font(20, True), fill=INK)
        draw.text((x - 2, plot[3] + 52), f"t = {material.thickness_um:.0f} μm",
                  font=font(17), fill=MUTED)
        x += bar_width + gap
    draw.rounded_rectangle((150, 790, 1480, 835), radius=12, fill="#F3F5F7")
    draw.text(
        (175, 801),
        "连续环结果说明材料/厚度对支撑力高度敏感；不能直接把连续环值当成成品支架径向力。",
        font=font(18),
        fill=INK,
    )
    path = FIG_DIR / "ring-stiffness.png"
    image.save(path)
    return path


def pipe_fd(n: int, radius: float, length: float, mu: float,
            pressure_drop: float) -> dict[str, float]:
    h = radius / n
    gradient = -pressure_drop / length
    matrix = np.zeros((n + 1, n + 1), dtype=float)
    rhs = np.zeros(n + 1, dtype=float)

    # Axis: L'Hopital limit 2 u'' = (1/mu) dp/dx.
    matrix[0, 0] = -4.0 / h**2
    matrix[0, 1] = 4.0 / h**2
    rhs[0] = gradient / mu

    for i in range(1, n):
        r = i * h
        matrix[i, i - 1] = 1.0 / h**2 - 1.0 / (2.0 * h * r)
        matrix[i, i] = -2.0 / h**2
        matrix[i, i + 1] = 1.0 / h**2 + 1.0 / (2.0 * h * r)
        rhs[i] = gradient / mu

    matrix[n, n] = 1.0
    rhs[n] = 0.0
    velocity = np.linalg.solve(matrix, rhs)
    r = np.linspace(0.0, radius, n + 1)
    exact = pressure_drop / (4.0 * mu * length) * (radius**2 - r**2)
    error = np.linalg.norm(velocity - exact) / np.linalg.norm(exact)
    wall_gradient = (3.0 * velocity[-1] - 4.0 * velocity[-2] + velocity[-3]) / (2.0 * h)
    wss_numeric = -mu * wall_gradient
    wss_exact = pressure_drop * radius / (2.0 * length)
    return {
        "n": n,
        "relative_L2_error": float(error),
        "centerline_velocity_m_s": float(velocity[0]),
        "centerline_exact_m_s": float(exact[0]),
        "wss_numeric_pa": float(wss_numeric),
        "wss_exact_pa": float(wss_exact),
        "wss_relative_error": float(abs(wss_numeric - wss_exact) / wss_exact),
    }


def axisymmetric_cylinder_fem(n: int, inner_radius: float, outer_radius: float,
                              young_modulus: float, poisson: float,
                              internal_pressure: float) -> dict[str, float]:
    nodes = np.linspace(inner_radius, outer_radius, n + 1)
    ndof = n + 1
    stiffness = np.zeros((ndof, ndof), dtype=float)
    force = np.zeros(ndof, dtype=float)

    lam = young_modulus * poisson / ((1 + poisson) * (1 - 2 * poisson))
    mu = young_modulus / (2 * (1 + poisson))
    elasticity = np.array([[lam + 2 * mu, lam], [lam, lam + 2 * mu]], dtype=float)

    gauss_points = [-math.sqrt(3.0 / 5.0), 0.0, math.sqrt(3.0 / 5.0)]
    gauss_weights = [5.0 / 9.0, 8.0 / 9.0, 5.0 / 9.0]

    for element in range(n):
        r1 = nodes[element]
        r2 = nodes[element + 1]
        h = r2 - r1
        midpoint = 0.5 * (r1 + r2)
        local = np.zeros((2, 2), dtype=float)
        for xi, weight in zip(gauss_points, gauss_weights):
            radius = midpoint + 0.5 * h * xi
            n1 = 0.5 * (1.0 - xi)
            n2 = 0.5 * (1.0 + xi)
            b = np.array([
                [-1.0 / h, 1.0 / h],
                [n1 / radius, n2 / radius],
            ])
            # Integrate over the full circumference.
            local += (
                2.0
                * math.pi
                * radius
                * (0.5 * h)
                * weight
                * (b.T @ elasticity @ b)
            )
        stiffness[element : element + 2, element : element + 2] += local

    force[0] = 2.0 * math.pi * inner_radius * internal_pressure
    displacement = np.linalg.solve(stiffness, force)

    a2 = inner_radius**2
    b2 = outer_radius**2
    factor = internal_pressure * a2 / (young_modulus * (b2 - a2))
    exact = factor * (
        (1 + poisson) * (1 - 2 * poisson) * nodes
        + (1 + poisson) * b2 / nodes
    )
    relative_error = np.linalg.norm(displacement - exact) / np.linalg.norm(exact)
    hoop_inner_exact = internal_pressure * (b2 + a2) / (b2 - a2)

    # Recover the hoop stress at the inner Gauss point of the first element.
    r1, r2 = nodes[0], nodes[1]
    h = r2 - r1
    xi = -math.sqrt(3.0 / 5.0)
    radius = 0.5 * (r1 + r2) + 0.5 * h * xi
    n1 = 0.5 * (1.0 - xi)
    n2 = 0.5 * (1.0 + xi)
    b = np.array([
        [-1.0 / h, 1.0 / h],
        [n1 / radius, n2 / radius],
    ])
    stress = elasticity @ (b @ displacement[:2])
    hoop_inner_fem = float(stress[1])
    return {
        "n": n,
        "relative_L2_displacement_error": float(relative_error),
        "inner_displacement_fem_m": float(displacement[0]),
        "inner_displacement_exact_m": float(exact[0]),
        "inner_hoop_stress_fem_pa": hoop_inner_fem,
        "inner_hoop_stress_exact_pa": float(hoop_inner_exact),
        "hoop_stress_relative_error": float(abs(hoop_inner_fem - hoop_inner_exact) / hoop_inner_exact),
    }


def draw_convergence_figure(flow_errors: list[dict[str, float]],
                            cylinder_errors: list[dict[str, float]]) -> Path:
    image = Image.new("RGB", (1600, 900), WHITE)
    draw = ImageDraw.Draw(image)
    draw.text((70, 40), "结构实现验证：网格加密后的误差收敛", font=font(40, True), fill=INK)
    draw.text((70, 100), "厚壁圆筒基准 vs 轴对称有限元解；流量基准解析误差为机器精度",
              font=font(21), fill=MUTED)
    plot = (180, 230, 1450, 720)
    draw_axes(draw, plot, "", "径向网格节点数 N", "")

    for n in [10, 20, 40, 80, 160]:
        x = map_x(math.log10(n), (math.log10(8), math.log10(180)), plot)
        draw.line((x, plot[1], x, plot[3]), fill=GRID, width=1)
        draw.text((x - 8, plot[3] + 10), str(n), font=font(18), fill=MUTED)
    for value in [1e-5, 1e-4, 1e-3, 1e-2, 1e-1]:
        y = map_y(math.log10(value), (-5, 0), plot)
        draw.line((plot[0], y, plot[2], y), fill=GRID, width=1)
        draw.text((plot[0] - 62, y - 12), f"{value:.0e}", font=font(17), fill=MUTED)

    cyl_series = [
        (map_x(math.log10(row["n"]), (math.log10(8), math.log10(180)), plot),
         map_y(math.log10(max(row["relative_L2_displacement_error"], 1e-8)), (-5, 0), plot))
        for row in cylinder_errors
    ]
    hoop_series = [
        (map_x(math.log10(row["n"]), (math.log10(8), math.log10(180)), plot),
         map_y(math.log10(max(row["hoop_stress_relative_error"], 1e-6)), (-5, 0), plot))
        for row in cylinder_errors
    ]
    draw.line(cyl_series, fill=TEAL, width=5)
    draw.line(hoop_series, fill=ORANGE, width=5)
    for x, y in cyl_series:
        draw.ellipse((x - 6, y - 6, x + 6, y + 6), fill=TEAL)
    for x, y in hoop_series:
        draw.ellipse((x - 6, y - 6, x + 6, y + 6), fill=ORANGE)

    draw.line((1080, 820, 1120, 820), fill=TEAL, width=5)
    draw.text((1130, 805), "径向位移 L2 相对误差", font=font(18), fill=INK)
    draw.line((1080, 850, 1120, 850), fill=ORANGE, width=5)
    draw.text((1130, 835), "内壁环向应力相对误差", font=font(18), fill=INK)
    path = FIG_DIR / "validation-convergence.png"
    image.save(path)
    return path


def build() -> None:
    radius = 1.5e-3
    length = 18e-3
    rho = 1025.0
    mu = 1.5e-3
    q_values = [20, 40, 60, 80, 100, 120, 150, 200]
    flow_rows: list[dict[str, float]] = []
    for q_ml_min in q_values:
        q = q_ml_min * 1e-6 / 60.0
        area = math.pi * radius**2
        velocity = q / area
        # Hydraulic diameter of the tube is 2R.
        reynolds = rho * velocity * (2.0 * radius) / mu
        pressure_drop = 8.0 * mu * length * q / (math.pi * radius**4)
        wss = 4.0 * mu * q / (math.pi * radius**3)
        flow_rows.append(
            {
                "Q_ml_min": float(q_ml_min),
                "mean_velocity_m_s": velocity,
                "Re": reynolds,
                "pressure_drop_pa": pressure_drop,
                "WSS_Pa": wss,
            }
        )

    pressure_drop_ref = next(row["pressure_drop_pa"] for row in flow_rows if row["Q_ml_min"] == 100)
    flow_errors = [
        pipe_fd(n, radius, length, mu, pressure_drop_ref)
        for n in (20, 40, 80, 160, 320)
    ]

    cylinder_errors = [
        axisymmetric_cylinder_fem(n, 1.5e-3, 2.0e-3, 1.0e6, 0.45, 13332.2)
        for n in (20, 40, 80, 160, 320)
    ]

    materials = [
        StentMaterial("WE43 Mg", 44.2, 120.0, "MatWeb elastic modulus"),
        StentMaterial("PLLA", 3.5, 180.0, "MatWeb modulus midpoint"),
        StentMaterial("PLGA 85/15", 3.0, 180.0, "MatWeb modulus midpoint"),
    ]
    ring_rows = []
    for material in materials:
        e = material.modulus_gpa * 1e9
        t = material.thickness_um * 1e-6
        k_line = e * t**3 / (12.0 * radius**3)
        ring_rows.append(
            {
                "material": material.name,
                "E_GPa": material.modulus_gpa,
                "thickness_um": material.thickness_um,
                "k_line_N_m2": k_line,
                "force_at_0p1mm_N_per_mm": k_line * 0.1e-3 * 1e-3,
                "force_at_0p2mm_N_per_mm": k_line * 0.2e-3 * 1e-3,
                "note": material.note,
            }
        )

    rows: list[dict[str, object]] = []
    for row in flow_rows:
        rows.append({"case": "flow-window", **row})
    for row in flow_errors:
        rows.append({"case": "poiseuille-verification", **row})
    for row in cylinder_errors:
        rows.append({"case": "axisymmetric-cylinder-verification", **row})
    for row in ring_rows:
        rows.append({"case": "continuous-ring-scaling", **row})

    keys: list[str] = []
    for row in rows:
        for key in row:
            if key not in keys:
                keys.append(key)
    with RESULT_CSV.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=keys)
        writer.writeheader()
        writer.writerows(rows)

    summary = {
        "source_reference": "Manuscript_21_7_2026.pdf",
        "date": "2026-10-18",
        "reference_geometry": {
            "artery_or_stent_radius_m": radius,
            "stent_length_m": length,
            "fluid_density_kg_m3": rho,
            "dynamic_viscosity_pa_s": mu,
        },
        "flow_window": flow_rows,
        "poiseuille_verification": flow_errors,
        "axisymmetric_cylinder_verification": cylinder_errors,
        "continuous_ring_scaling": ring_rows,
        "figures": [
            str(draw_framework()),
            str(draw_flow_figure(flow_rows)),
            str(draw_convergence_figure(flow_errors, cylinder_errors)),
            str(draw_stiffness_figure(materials)),
        ],
        "limitations": [
            "continuous ring is a scaling check, not a lattice stent simulation",
            "flow benchmark is steady Newtonian flow",
            "axisymmetric cylinder is a verification case for the structural implementation",
            "no clinical validation is implied",
        ],
    }
    SUMMARY_JSON.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(RESULT_CSV)
    print(SUMMARY_JSON)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    build()

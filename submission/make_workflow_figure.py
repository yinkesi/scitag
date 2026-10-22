# -*- coding: utf-8 -*-
"""Two-lane workflow figure (compact, print-friendly) + whitespace crop."""
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
from PIL import Image, ImageChops

OUT = Path(__file__).resolve().parent
plt.rcParams.update({"font.family": "Segoe UI", "font.size": 10})

INK = "#1d232b"
MUTED = "#5b6b7a"
TEAL = "#2f8f6f"
BLUE = "#3b6ea5"
AMBER = "#c9822b"
PURPLE = "#6b5aa6"
PAPER = (247, 249, 252)
EDGE = "#c9d3dd"


def box(ax, x, y, w, h, title, lines, accent):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.12,rounding_size=0.35",
                                fc="#ffffff", ec=EDGE, lw=1.0, zorder=2))
    ax.add_patch(FancyBboxPatch((x + 0.05, y + 0.18), 0.28, h - 0.36,
                                boxstyle="round,pad=0,rounding_size=0.14",
                                fc=accent, ec="none", zorder=3))
    ax.text(x + 0.75, y + h - 0.42, title, fontsize=11.8, fontweight="bold", color=INK,
            ha="left", va="center", zorder=4)
    for i, line in enumerate(lines):
        ax.text(x + 0.75, y + h - 0.98 - i * 0.40, line, fontsize=9.8, color=MUTED,
                ha="left", va="center", zorder=4)


def arrow(ax, x1, y1, x2, y2, color=INK, lw=1.4):
    ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle="-|>", mutation_scale=11,
                                 color=color, lw=lw, zorder=1, shrinkA=2, shrinkB=2))


def main():
    fig, ax = plt.subplots(figsize=(10, 5.2), dpi=300)
    fig.patch.set_facecolor("#f7f9fc")
    ax.set_xlim(0, 100)
    ax.set_ylim(0.9, 10)
    ax.axis("off")

    # lane 1
    ax.text(2, 9.45, "01   Run-time workflow", fontsize=15, fontweight="bold", color=INK)
    ax.text(2, 9.02, "patient case  →  audited, tool-grounded answer", fontsize=10.2, color=MUTED)

    xs = [2, 21.6, 41.2, 60.8, 80.4]
    w, h1, y1 = 16.4, 2.0, 6.4
    row1 = [
        ("Patient case", ["lesion / vessel", "pressure / intent"], BLUE),
        ("SciTag agent", ["resident 4B LoRA", "human-gated"], TEAL),
        ("Pre-flight tool", ["concept: budget,", "load, sealing force"], AMBER),
        ("Real JSON", ["270 µg · 0.335 N", "Fe / Zn / Mg shortlist"], PURPLE),
        ("Owner approval", ["published answer", "+ provenance"], TEAL),
    ]
    for x, (t, lines, c) in zip(xs, row1):
        box(ax, x, y1, w, h1, t, lines, c)
    for i in range(4):
        arrow(ax, xs[i] + w + 0.05, y1 + h1 / 2, xs[i + 1] - 0.1, y1 + h1 / 2)

    ax.text(xs[2] + w / 2, y1 - 0.36, "tool executes before the model speaks", fontsize=9.4,
            color=AMBER, ha="center", style="italic")
    ax.text(xs[4] + w / 2, y1 - 0.36, "audit: command · exit 0 · SHA-256", fontsize=9.4,
            color=TEAL, ha="center", style="italic")

    # win-rate chip
    ax.add_patch(FancyBboxPatch((73.4, 9.05), 24.8, 0.92, boxstyle="round,pad=0.08,rounding_size=0.22",
                                fc="#eaf5ef", ec=TEAL, lw=1.0, zorder=3))
    ax.text(85.8, 9.51, "win rate  51.67%  →  90.67%", fontsize=11, color=TEAL,
            fontweight="bold", ha="center", va="center", zorder=4)

    # lane 2
    ax.text(2, 5.5, "02   Adaption training loop", fontsize=15, fontweight="bold", color=INK)
    ax.text(2, 5.07, "domain knowledge  →  local 4-bit model  →  back into the agent", fontsize=10.2, color=MUTED)

    y2, h2 = 2.1, 2.0
    row2 = [
        ("Domain knowledge", ["KB + real tool", "outputs"], BLUE),
        ("1,392 rows", ["144 held out", "template + formulas"], PURPLE),
        ("Adaptive Data", ["shapes and", "augments"], AMBER),
        ("AutoScientist", ["LoRA r32 · 3 ep", "lr 1e-4"], TEAL),
        ("Local 4-bit model", ["3.2 GB VRAM · 5 tok/s", "OpenAI-compatible"], BLUE),
    ]
    for x, (t, lines, c) in zip(xs, row2):
        box(ax, x, y2, w, h2, t, lines, c)
    for i in range(4):
        arrow(ax, xs[i] + w + 0.05, y2 + h2 / 2, xs[i + 1] - 0.1, y2 + h2 / 2)

    # feedback loop
    xm = xs[4] + w / 2
    xa = xs[1] + w / 2
    yl = 4.62
    ax.plot([xm, xm], [y2 + h2, yl], color=TEAL, lw=1.3, ls="--", zorder=1)
    ax.plot([xm, xa], [yl, yl], color=TEAL, lw=1.3, ls="--", zorder=1)
    ax.annotate("", xy=(xa, y1 - 0.02), xytext=(xa, yl),
                arrowprops=dict(arrowstyle="-|>", color=TEAL, lw=1.3, shrinkA=0, shrinkB=1))
    ax.text((xm + xa) / 2, yl + 0.13, "re-deploy into SciTag as a resident llm agent",
            fontsize=9.4, color=TEAL, ha="center", style="italic")

    fig.tight_layout(pad=0.25)
    p = OUT / "figure-workflow.png"
    fig.savefig(p, facecolor=fig.get_facecolor(), bbox_inches="tight")
    plt.close(fig)

    # crop remaining whitespace
    im = Image.open(p).convert("RGB")
    bg = Image.new("RGB", im.size, PAPER)
    bbox = ImageChops.difference(im, bg).getbbox()
    if bbox:
        pad = 24
        im = im.crop((max(0, bbox[0] - pad), max(0, bbox[1] - pad),
                      min(im.width, bbox[2] + pad), min(im.height, bbox[3] + pad)))
        im.save(p)
    print("figure", p, im.size)


if __name__ == "__main__":
    main()

# -*- coding: utf-8 -*-
"""Submission figures: win-rate ablation + pipeline overview."""
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

OUT = Path(__file__).resolve().parent
plt.rcParams.update({"font.size": 12, "axes.spines.top": False, "axes.spines.right": False})

# 1) Win-rate ablation
runs = ["v1\nr16, 1 epoch", "v2\nreasoning data", "v1-strong\nr32, 3 epochs"]
scores = [51.67, 40.43, 90.67]
colors = ["#8fb8de", "#d98c8c", "#2f6f4f"]
fig, ax = plt.subplots(figsize=(7.2, 3.6), dpi=200)
bars = ax.bar(runs, scores, color=colors, width=0.55)
ax.set_ylim(0, 105)
ax.set_ylabel("Win rate vs base (%)")
ax.axhline(50, color="#999", lw=1, ls="--")
ax.text(2.35, 52, "tie with base", color="#666", fontsize=9)
for b, s in zip(bars, scores):
    ax.text(b.get_x() + b.get_width() / 2, s + 2, f"{s:.2f}%", ha="center", fontweight="bold")
ax.set_title("Adaption AutoScientist on held-out preference eval (Qwen3.5-4B)", fontsize=11)
fig.tight_layout()
fig.savefig(OUT / "figure-winrate.png", bbox_inches="tight")
plt.close(fig)

# 2) Pipeline overview
fig, ax = plt.subplots(figsize=(9.2, 3.4), dpi=200)
ax.axis("off")
boxes = [
    (0.02, 0.52, "Patient case\nlesion, vessel,\npressure", "#e8eef5"),
    (0.22, 0.52, "SciTag agent\n(4B LoRA)", "#dcebdd"),
    (0.42, 0.52, "Domain tool\nconcept / materials", "#f3e6c8"),
    (0.62, 0.52, "Tool JSON\nnumbers + shortlist", "#e8eef5"),
    (0.82, 0.52, "Owner approval\n& provenance", "#f0d9d9"),
]
for x, y, label, color in boxes:
    ax.add_patch(FancyBboxPatch((x, y), 0.16, 0.28, boxstyle="round,pad=0.02,rounding_size=0.02",
                                fc=color, ec="#555", lw=1))
    ax.text(x + 0.08, y + 0.14, label, ha="center", va="center", fontsize=8.5)
for i in range(len(boxes) - 1):
    ax.add_patch(FancyArrowPatch((boxes[i][0] + 0.16, 0.66), (boxes[i + 1][0], 0.66),
                                 arrowstyle="-|>", mutation_scale=14, color="#555"))
ax.text(0.5, 0.18, "Adaption: 1,392 rows -> Adaptive Data -> AutoScientist (LoRA) -> merged 4-bit model served at 127.0.0.1:8780",
        ha="center", fontsize=8.5, color="#444")
ax.set_xlim(0, 1); ax.set_ylim(0, 0.95)
fig.savefig(OUT / "figure-pipeline.png", bbox_inches="tight")
plt.close(fig)
print("figures written")

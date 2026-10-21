# -*- coding: utf-8 -*-
"""Build the 4-minute English submission video: slides + SAPI narration + ffmpeg."""
import json, subprocess, wave
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg

HERE = Path(__file__).resolve().parent
OUT = HERE / "video"
OUT.mkdir(exist_ok=True)
W, H = 1920, 1080
BG = (15, 27, 42)
FG = (238, 243, 248)
ACCENT = (127, 209, 165)
MUTED = (150, 168, 186)

FONT = "C:/Windows/Fonts/segoeui.ttf"
FONT_B = "C:/Windows/Fonts/segoeuib.ttf"
FONT_MONO = "C:/Windows/Fonts/consola.ttf"


def font(size, bold=False, mono=False):
    path = FONT_MONO if mono else (FONT_B if bold else FONT)
    return ImageFont.truetype(path, size)


SLIDES = [
    {
        "id": "01",
        "title": "Auditable AI for vascular device design",
        "bullets": ["SciTag multi-agent harness", "Adaption-tuned 4B domain model", "Tool-grounded, human-approved answers"],
        "narration": "What if a small language model, tuned on domain data, could do part of a research team's work, and prove it? This is SciTag, a human-gated multi-agent research harness, combined with a four-billion-parameter model tuned on Adaption. Our task: screening concepts for bioresorbable vascular devices.",
    },
    {
        "id": "02",
        "title": "The problem: a decision before design",
        "bullets": ["Drug-eluting stent vs occluder / plug", "Inputs: lesion size, vessel, pressure", "Output must be quantified, not vibes"],
        "narration": "Before any design work, the team must choose between a drug-eluting stent that preserves blood flow, and an occluder or plug that permanently seals a vessel. The inputs are clinical: lesion size, target vessel diameter, blood pressure, and intent. The output must be quantitative and auditable. A generic chatbot opinion is not enough.",
    },
    {
        "id": "03",
        "title": "SciTag: agents with tools and a human gate",
        "bullets": ["Domain package: KB, skills, data, tools", "Agent calls concept / materials tools", "Owner approves before publish"],
        "narration": "SciTag gives each agent a domain package: knowledge base, skills, data, and declared analysis tools. The vascular-stent package exposes a zero-dependency Python tool that computes drug payload budgets, sealing forces, and material shortlists. Every tool run carries a provenance record. The agent reports to its human owner, who must approve before the result is published.",
    },
    {
        "id": "04",
        "title": "Adaption: data to a deployable model",
        "bullets": ["1,392 instruction rows + 144 held-out", "Adaptive Data, then AutoScientist", "Qwen3.5-4B, LoRA, downloadable"],
        "narration": "We generated one thousand three hundred ninety-two instruction rows from the domain knowledge base and real tool outputs, with a held-out split of one hundred forty-four rows. Adaption's Adaptive Data shaped the dataset, and AutoScientist trained a LoRA adapter on Qwen three point five four B. The weights are downloadable and run locally.",
    },
    {
        "id": "05",
        "title": "Result: training strength was the bottleneck",
        "bullets": ["v1: 51.67% (near tie)", "v2 reasoning data: 40.43%", "v1-strong: 90.67%"],
        "narration": "The first run reached only fifty-one point six seven percent win rate, essentially a tie with the base model. A second dataset with reasoning traces scored worse, forty point four three percent. Same data, stronger LoRA, three epochs, rank thirty-two: ninety point six seven percent. The lesson is clear. Training strength mattered more than data style.",
        "image": "figure-winrate.png",
    },
    {
        "id": "06",
        "title": "Deployment: local, quantized, OpenAI-compatible",
        "bullets": ["LoRA merged into base weights", "4-bit NF4, 3.2 GB VRAM", "5 tokens/s on a laptop GPU", "Served at 127.0.0.1:8780"],
        "narration": "The adapter is merged into the base weights and served as an OpenAI-compatible endpoint. In four-bit mode it needs three point two gigabytes of video memory and produces about five tokens per second on a laptop GPU. No external API. Data stays on the machine.",
    },
    {
        "id": "07",
        "title": "Demo: numbers come from the tool",
        "bullets": [
            "A: 270 µg payload ≈ 1.39e-5 of oral dose → not viable",
            "B: 167 mN load → 0.335 N sealing force",
            "Materials: Fe / Zn / Mg pass 1.5x margin",
            "Audit: concept, exit 0, SHA-256 provenance",
        ],
        "narration": "Here is a real case: hepatic artery, four millimeter lesion, one hundred millimeters of mercury. The drug arm delivers about two hundred seventy micrograms, roughly one point four times ten to the minus five of an oral dose, not viable. The occlusion arm needs zero point three three five newtons of sealing force, and iron, zinc, and magnesium frames pass the margin screen. The platform records the tool, the exit code, and data hashes, so the number can be audited.",
    },
    {
        "id": "08",
        "title": "Three engineering lessons",
        "bullets": ["Adapter keys must match the text model", "Long contexts overflow 8 GB VRAM", "Models fake tool calls — force real ones"],
        "narration": "Three lessons. First, Adaption's adapter keys were named for the multimodal model, so they silently failed on the text model; we remapped and merged them manually. Second, long contexts overflowed eight gigabytes, so tool rounds now use a lean context. Third, the model sometimes faked tool calls in prose, so the harness now pre-executes the analysis tool and feeds back real JSON.",
    },
    {
        "id": "09",
        "title": "Limitations and next steps",
        "bullets": ["4B assistant, not a clinician", "No corrosion or fatigue data yet", "Repo + dataset + video in submission"],
        "narration": "This is a domain assistant, not a clinician. It does not diagnose or size devices. The material library still lacks corrosion and fatigue data, and all shortlists need bench and animal validation. The code, dataset, and this video are in the submission repository. Thanks to Adaption and SciTag.",
    },
]


def wrap(draw, text, fnt, max_w):
    words = text.split()
    lines, cur = [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if draw.textlength(trial, font=fnt) <= max_w:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def render_slide(s, path):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 8], fill=ACCENT)
    d.text((110, 90), "SciTag × Adaption", font=font(30, bold=True), fill=ACCENT)
    d.text((110, 170), s["title"], font=font(64, bold=True), fill=FG)
    y = 300
    for b in s["bullets"]:
        lines = wrap(d, b, font(38), W - 300)
        d.ellipse([112, y + 14, 126, y + 28], fill=ACCENT)
        for ln in lines:
            d.text((150, y), ln, font=font(38), fill=FG)
            y += 52
        y += 14
    if s.get("image"):
        im = Image.open(HERE / s["image"]).convert("RGB")
        im.thumbnail((1200, 430))
        img.paste(im, ((W - im.width) // 2, 560))
    d.text((110, H - 70), "Open Scientific Intelligence Hackathon · 2026-10-21", font=font(24), fill=MUTED)
    img.save(path)


def main():
    tts = [{"id": s["id"], "text": s["narration"]} for s in SLIDES]
    (OUT / "tts.json").write_text(json.dumps(tts, ensure_ascii=False, indent=2), encoding="utf-8")
    for s in SLIDES:
        render_slide(s, OUT / f"slide-{s['id']}.png")
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(HERE / "tts.ps1"),
                    "-Json", str(OUT / "tts.json"), "-OutDir", str(OUT)], check=True, timeout=600)

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    segs = []
    total = 0.0
    for s in SLIDES:
        wav = OUT / f"audio-{s['id']}.wav"
        with wave.open(str(wav), "rb") as fh:
            dur = fh.getnframes() / fh.getframerate()
        total += dur
        seg = OUT / f"seg-{s['id']}.mp4"
        subprocess.run([ffmpeg, "-y", "-loop", "1", "-i", str(OUT / f"slide-{s['id']}.png"),
                        "-i", str(wav), "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p",
                        "-c:a", "aac", "-b:a", "160k", "-shortest", str(seg)],
                       check=True, capture_output=True, timeout=300)
        segs.append(seg)
    lst = OUT / "concat.txt"
    lst.write_text("".join(f"file '{p.name}'\n" for p in segs), encoding="utf-8")
    final = HERE / "scitag-adaption-demo.mp4"
    subprocess.run([ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(final)],
                   check=True, capture_output=True, timeout=300)
    print("narration seconds %.1f (%.1f min)" % (total, total / 60))
    print("video", final, final.stat().st_size)


if __name__ == "__main__":
    main()


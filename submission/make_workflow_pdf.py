# -*- coding: utf-8 -*-
"""One-page system report with the workflow figure; prints to PDF and copies to Desktop."""
import shutil, subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
fig = (HERE / "figure-workflow.png").as_uri()

html = f"""<!doctype html><html><head><meta charset="utf-8"><style>
@page {{ size: A4; margin: 13mm 13mm 11mm 13mm; }}
body {{ font-family: 'Segoe UI', Arial, sans-serif; color:#1d232b; font-size: 9.4pt; line-height:1.4; }}
h1 {{ font-size: 17pt; margin: 0 0 1mm 0; color:#14324f; }}
.sub {{ color:#5b6b7a; font-size: 9pt; margin: 0 0 3mm 0; }}
img {{ width: 100%; border: 1px solid #dbe3ea; border-radius: 6px; }}
h2 {{ font-size: 11.5pt; margin: 3.6mm 0 1mm 0; color:#14324f; }}
p {{ margin: 1mm 0; }}
b {{ color:#14324f; }}
.small {{ color:#5b6b7a; font-size:8.6pt; }}
</style></head><body>
<h1>System direction — workflow, results, next steps</h1>
<div class="sub">SciTag human-gated multi-agent harness × Adaption-tuned Qwen3.5-4B · system companion to the materials section</div>
<img src="{fig}" alt="workflow">
<h2>Approach</h2>
<p><b>SciTag</b> is a human-gated multi-agent harness: each agent mounts a domain package (knowledge base, skills, data, tools declared in <i>domain.json</i>). In the <i>vascular-stent</i> package, a zero-dependency Python tool computes drug-payload budgets, defect pressure loads, required sealing forces, and material shortlists with degradation screening; every run returns provenance (command, parameters, exit code, SHA-256 of data and script), and the agent reports to its human owner before publication.</p>
<p><b>Adaption</b> turns the same knowledge into a local model: 1,392 instruction rows (144 held out) → Adaptive Data → AutoScientist LoRA on Qwen3.5-4B. The adapter is merged into the base weights and served 4-bit (≈3.2 GB VRAM, ≈5 tokens/s) behind an OpenAI-compatible endpoint, then registered in SciTag as a resident agent. The harness pre-executes the <i>concept</i> tool on the case text and feeds the real JSON to the model, so answers cite tool numbers rather than guesses.</p>
<h2>Results</h2>
<p>Same data, three training runs: default LoRA <b>51.67%</b> win rate (tie with base), a reasoning-trace dataset <b>40.43%</b> (negative result), and stronger LoRA (r=32, 3 epochs, lr 1e-4) <b>90.67%</b>. On a local held-out check, numeric recall improved from <b>27.8% to 33.6%</b> and required-phrase coverage from <b>22.5% to 38.6%</b>. End to end, a hepatic-artery case (4.0 mm lesion, 3.0 mm vessel, 100 mmHg, permanent embolization) reports the drug arm at ≈270 µg (1.39×10⁻⁵ of an oral dose, not viable), the occlusion arm at 167 mN static load → <b>0.335 N</b> sealing force, and Fe/Zn/Mg frames passing the 1.5× margin — with an audit record (<i>concept</i>, exit 0, SHA-256). The harness passes its full suite (119 regression tests plus 10 tool-protocol tests).</p>
<h2>Next steps</h2>
<p>Add corrosion/fatigue kinetics and more polymer grades; collect 20–30 clinician reviews and run a DPO preference pass; benchmark the tuned 4B model against a larger open model; package one-command local deployment with a user guide and demo video.</p>
</body></html>"""
(HERE / "system-workflow.html").write_text(html, encoding="utf-8")

edge = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
pdf = HERE / "system-workflow.pdf"
subprocess.run([edge, "--headless=new", "--disable-gpu", "--no-pdf-header-footer", f"--print-to-pdf={pdf}",
                (HERE / "system-workflow.html").as_uri()], check=True, timeout=120)
desktop = Path(subprocess.run(["powershell", "-NoProfile", "-Command",
                               "[Environment]::GetFolderPath('Desktop')"],
                              capture_output=True, text=True).stdout.strip())
shutil.copyfile(pdf, desktop / "SciTag-System-Workflow.pdf")
print("pdf", pdf, pdf.stat().st_size)
print("desktop", desktop / "SciTag-System-Workflow.pdf")


# Submission package — SciTag × Adaption

Everything needed for the Open Scientific Intelligence Hackathon submission is in this folder.

## What is here

| File | Purpose |
| --- | --- |
| `ONE-PAGER.md` / `one-pager.pdf` | One-page summary (English, A4) |
| `SYSTEM-SECTION.md` / `system-workflow.pdf` | System-direction report section (approach / results / next steps) with a two-lane workflow diagram; one A4 page — merge with the teammate's materials section |
| `SPEECH.md` | 4-minute English speech script (timed sections + recording checklist) |
| `OPERATIONS.md` | 操作方法：启动/演示/审计/关闭/排错（中英对照命令） |
| `VIDEO-SCRIPT.md` | Optional shot list / slide outline |
| `figure-winrate.png` | Win-rate ablation chart (v1 / v2 / v1-strong) |
| `figure-pipeline.png` | Legacy system diagram (superseded by `figure-workflow.png`) |
| `figure-workflow.png` | Polished workflow diagram embedded in `system-workflow.pdf` |
| `make_figures.py`, `make_onepager.py`, `make_workflow_figure.py`, `make_workflow_pdf.py` | Reproducible generation of figures, one-pager, workflow diagram, and the system PDF |

> The demo video is **not** included: record your own with `SPEECH.md` (≤ 4:00, no speed-up). `make_video.py` / `tts.ps1` remain in the repo if a generated version is ever needed, but the submission uses the human-recorded video.

## Submission form fields (copy-paste)

- **Title:** Auditable concept screening for bioresorbable vascular devices with an Adaption-tuned 4B model in SciTag
- **One-line description:** A human-gated multi-agent harness plus a locally served 4B domain model that calls real analysis tools and records provenance; held-out preference win rate 51.67% → 90.67% by stronger LoRA training.
- **Repo:** `https://github.com/yinkesi/scitag` (make public before submitting)
- **Video:** record with `SPEECH.md` (≤ 4:00), upload to YouTube/Drive, paste the link
- **One-page summary:** upload `one-pager.pdf`
- **Track:** Adaption sponsor track (Adaptive Data + AutoScientist + local deployment)

## Pre-existing work disclosure (important)

- SciTag itself (multi-agent harness) and the `vascular-stent` domain package were built **before** the hackathon kickoff (Oct 20, 2026) and are disclosed as pre-existing infrastructure.
- The Adaption dataset, Adaptive Data runs, AutoScientist runs (v1, v2, v1-strong), and the SciTag↔Adaption integration were done during the event window (Oct 20–21, 2026).
- Raw MatWeb CSVs are **not** redistributed (license: internal research use). Only derived material rows and citations are included, as in the domain package.

## Before submitting — external steps (need account access)

1. **Make the GitHub repo public** (it is private now; `gh` is not authenticated in this environment). If a fresh public repo is preferred, push the current working tree and remove `data/db.json` (contains local demo state).
2. **Record the video** using `SPEECH.md` (screen recording, ≤ 4:00, no speed-up), upload to YouTube (public/unlisted) or Google Drive, set link sharing.
3. **Fill the official submission form** with the fields above and the one-page PDF.
4. Optional: add a short README at repo root pointing to `submission/`.

## Quick verification commands

```powershell
cd D:\code\scitag
npm test                      # full suite, expect exit 0 (119 regression tests included)

# start the local model + SciTag, then run the case end-to-end
cd D:\code\_adaption\dataset
$env:MODEL_DIR='D:\code\_adaption\models\Qwen3.5-4B-merged-v1strong'; $env:PORT='8780'; python serve_adapted.py
cd D:\code\scitag; $env:SCITAG_PORT='8790'; node server.js
node D:\code\_adaption\scitag_case_run.mjs http://127.0.0.1:8790
```

## Evidence log

- Platform runs: `_adaption/dataset/train-state*.json` (win rates 51.67 / 40.43 / 90.67).
- Held-out evaluation: `_adaption/dataset/out/eval-final.json` (base vs v1-strong).
- Detailed engineering notes: `_adaption/ADAPTION-SCITAG-NOTES.md`.
- Tests: `test-llm-tools.mjs` (pre-flight tool call, lean tool round, rejection paths) + full `npm test`.

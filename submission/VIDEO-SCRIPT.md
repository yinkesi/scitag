# Video script — SciTag × Adaption (English, 4:00 limit)

Runtime target: 4:00. Narration: ~470 words, SAPI "Microsoft Zira", no speed-up.
Source: `make_video.py` (slides + TTS + ffmpeg). Output: `scitag-adaption-demo.mp4`.

## 1. Title (≈22 s)
**Auditable AI for vascular device design**
- SciTag multi-agent harness
- Adaption-tuned 4B domain model
- Tool-grounded, human-approved answers

Narration: What if a small language model, tuned on domain data, could do part of a research team's work, and prove it? This is SciTag, a human-gated multi-agent research harness, combined with a four-billion-parameter model tuned on Adaption. Our task: screening concepts for bioresorbable vascular devices.

## 2. Problem (≈24 s)
The problem: a decision before design. Drug-eluting stent vs occluder/plug. Inputs: lesion size, vessel, pressure. Output must be quantified, not vibes.

## 3. SciTag harness (≈27 s)
Agents with tools and a human gate. Domain package: KB, skills, data, tools. Agent calls `concept` / `materials`; owner approves before publish.

## 4. Adaption pipeline (≈26 s)
Data to a deployable model. 1,392 instruction rows + 144 held-out. Adaptive Data → AutoScientist. Qwen3.5-4B, LoRA, downloadable.

## 5. Result (≈31 s)
Training strength was the bottleneck. v1 51.67% (near tie), v2 reasoning data 40.43%, v1-strong 90.67%. Same data, stronger LoRA.

## 6. Deployment (≈24 s)
Local, quantized, OpenAI-compatible. LoRA merged, 4-bit NF4, 3.2 GB VRAM, ~5 tokens/s on a laptop GPU, served at 127.0.0.1:8780.

## 7. Demo evidence (≈35 s)
Numbers come from the tool. A: 270 µg ≈ 1.39e-5 of oral dose → not viable. B: 167 mN load → 0.335 N sealing force. Materials Fe/Zn/Mg pass 1.5× margin. Audit: `concept`, exit 0, SHA-256 provenance.

## 8. Engineering lessons (≈31 s)
Adapter keys must match the text model (manual remap + merge). Long contexts overflow 8 GB VRAM (lean tool round). Models fake tool calls (force real pre-flight execution).

## 9. Limitations (≈20 s)
4B assistant, not a clinician. No corrosion/fatigue data yet. Repo + dataset + video in submission.

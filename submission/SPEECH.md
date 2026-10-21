# Speech script — SciTag × Adaption (English, ~4 minutes)

**Purpose:** record your own 4-minute demo video (or present live) with screen sharing.
**Deck:** `figure-winrate.png`, `figure-pipeline.png`, the SciTag web UI at `http://127.0.0.1:8790`.
**Rule:** no speed-up; keep it under 4:00. Target speaking rate ≈ 150 wpm.

---

## [0:00] Opening (20 s) — slide: title

> Hi, I'm presenting **SciTag** — a human-gated multi-agent harness for research — together with a four-billion-parameter domain model tuned on **Adaption**.
>
> Our question was simple: can a small domain model do real work in a research workflow, and prove what it did?

## [0:20] Problem (25 s) — slide: pipeline

> Here's the problem. Before any design work on a bioresorbable vascular device, the team must choose between a **drug-eluting stent** that keeps blood flowing, and an **occluder** that permanently seals a vessel — for example, a tumor-feeding artery.
>
> The inputs are clinical: lesion size, vessel diameter, blood pressure, and intent. The output has to be **quantitative**. A language model's opinion is not enough.

## [0:45] What we built (35 s) — slide: pipeline

> So we built the missing loop.
>
> **SciTag** gives every agent a domain package: a knowledge base, skills, data, and declared analysis tools. The `vascular-stent` package exposes a Python tool that computes the drug-payload budget, the static pressure load on a defect, the required sealing force, and a material shortlist with degradation windows.
>
> Every run produces a **provenance record**. And the agent reports to its human owner, who approves before anything is published.

## [1:20] Dataset and training (35 s) — slide: pipeline

> On the Adaption side, we generated **1,392 instruction rows** from that domain knowledge and real tool outputs, with a held-out set of 144 rows.
>
> **Adaptive Data** shaped the dataset, and **AutoScientist** trained a LoRA adapter on Qwen 3.5 4B. The weights are downloadable and run locally.

## [1:55] Results (40 s) — slide: win-rate chart

> Now the result.
>
> Our first run reached only **51.7%** win rate — essentially a tie with the base model. A second dataset with reasoning traces did worse: **40.4%**.
>
> Then we kept the **same data** and simply trained harder: rank 32, three epochs, learning rate 1e-4. That run reached **90.7%**.
>
> The lesson is clear: for this small model, **training strength mattered much more than data style**. On a local held-out check, numeric recall improved from **27.8% to 33.6%**, and required-phrase coverage from **22.5% to 38.6%**.

## [2:35] Live demo (60 s) — share SciTag UI

> Let me show the live path. *(open `http://127.0.0.1:8790`, channel "骨支架课题组")*
>
> I send a case: hepatic artery, four-millimeter lesion, three-millimeter vessel, one hundred millimeters of mercury, permanent embolization. *(type the case, press Enter)*
>
> The harness parses the case, **executes the analysis tool itself**, and feeds the real JSON back to the model.
>
> The answer says: the drug arm is not viable — about **270 micrograms**, roughly **1.4 × 10⁻⁵** of an oral dose. The occlusion arm needs **0.335 newtons** of sealing force, and iron, zinc, magnesium pass the margin screen.
>
> *(point at the audit record)* And here is the audit: domain `vascular-stent`, command `concept`, exit code zero, with SHA-256 hashes of the data and script. **The number can be checked, not just believed.**

## [3:35] Three engineering lessons (20 s) — slide: lessons

> Three lessons.
>
> First, the adapter's keys were named for the multimodal model, so they silently failed on the text model; we remapped and merged manually.
>
> Second, long contexts overflowed eight gigabytes of VRAM, so tool rounds use a lean context.
>
> Third, the model sometimes **faked** tool calls in prose, so the harness now pre-executes the tool and feeds back real JSON.

## [3:55] Close (10 s) — slide: limitations

> This is a domain assistant, not a clinician. It does not diagnose or size devices, and material shortlists still need bench and animal validation.
>
> But the pattern — **small, local, tool-grounded, auditable** — is what we wanted to demonstrate. Thank you.

---

## Recording checklist

- [ ] Terminal + browser side by side; zoom to 125% so text is legible.
- [ ] Close chat apps / notifications.
- [ ] Mic test; speak at a steady pace (≈150 wpm). Do not speed up the footage.
- [ ] Keep total length ≤ 4:00; the script above is ≈ 3:40–3:55 at that pace.
- [ ] If you fluff a line, pause 2 seconds and redo the paragraph — cut in editing (cuts are allowed; speed-up is not).
- [ ] Export 1080p MP4 (H.264 + AAC), ≤ 4:00.

## Exact demo input (copy-paste)

```
@支架适配模型 病例：肝动脉右支供血，病变/缺损直径 4.0 mm，目标血管 3.0 mm，病变长度 10 mm，血压 100 mmHg，术式意向：断流栓塞。请做概念筛选（A 载药 vs B 封堵）并给材料短名单与数据缺口。
```

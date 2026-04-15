# BrandStudios OS HUD — Agent Playbook

## What This Is

The product HUD for BrandStudios.AI. An Ironman-inspired operations interface that
orchestrates the full brand pipeline. This is the real product — the client-facing
tool that runs brand operations.

This repo is the **orchestrator**. Brand_linter, Temp-gen, and brand-engine all
feed into it — they're called by the runner pipeline, not standalone services.

---

## System Map

```
proto_front/
├── src/                    ← React 19 HUD (Vite + Tailwind v4)
│   ├── App.tsx             ← 5 pillar tabs, run controls
│   ├── api.ts              ← Supabase client, types, queries, realtime
│   ├── lib/supabase.ts     ← Supabase config
│   └── components/
│       ├── ReviewPanel.tsx          ← HITL review UI
│       ├── DeliverableTracker.tsx   ← Campaign deliverable lifecycle
│       ├── DriftAlertPanel.tsx      ← Drift alerts + acknowledgment
│       ├── BaselinePanel.tsx        ← Brand baseline snapshots
│       └── PromptEvolutionPanel.tsx ← Prompt performance + evolution
│
├── os-api/src/             ← Express API (orchestration layer)
│   ├── index.ts            ← Routes: runs, HITL, campaigns, deliverables, drift, prompts
│   ├── runner.ts           ← Pipeline executor — calls brand-engine :8100 + Temp-gen :8200
│   ├── db.ts               ← Supabase query layer, typed mappers
│   ├── types.ts            ← Shared types (Run, Artifact, Campaign, DriftAlert, etc.)
│   ├── storage.ts          ← Supabase Storage upload (dual-write to Cloudinary)
│   └── cloudinary.ts       ← Optional CDN — 10 platform presets
│
├── worker/                 ← Python worker (headless run execution)
│   ├── worker.py           ← Polls Supabase for runs
│   ├── config.py           ← Worker config
│   └── executors/          ← Stage executors (ingest, grading, prompt_evolver)
│
├── brand-engine/           ← Python SDK (consolidated from Brand_linter + BDE)
│   ├── brand_engine/core/  ← 7 modules: embeddings, retrieval, drift, fusion, trainer
│   ├── api/server.py       ← FastAPI sidecar on :8100
│   └── cli/main.py         ← CLI interface
│
├── supabase/migrations/    ← 6 migrations (001-006)
├── hud.json                ← Client data + UI config (source of truth)
└── docs/                   ← Integration audit, tech requirements
```

### Connected Repos (called by runner, not standalone)

| Repo | Location | What It Does | How It's Called |
|------|----------|-------------|-----------------|
| **Brand_linter** | `~/Brand_linter/local_quick_setup` | Brand compliance CLI (triple fusion scoring) | Runner subprocess (being deprecated → brand-engine) |
| **Temp-gen** | `~/Temp-gen` | AI image/video generation (Gemini 3 Pro, Veo 3.1) | FastAPI sidecar :8200 (runner HTTP calls) |
| **brand-engine** | `proto_front/brand-engine/` | Consolidated SDK — embeddings, drift, RL | FastAPI sidecar :8100 (runner) + direct import (worker) |

---

## The Pipeline

```
ingest → retrieve → generate → drift → hitl → export
```

- **Runner** (TypeScript, os-api) → calls brand-engine sidecar :8100 for ingest, retrieve, drift
- **Runner** → calls Temp-gen sidecar :8200 for generate (image sync, video async+poll)
- **Worker** (Python) → imports `brand_engine.core` directly for headless execution
- **Realtime** → SSE log streaming for pipeline execution, Supabase Realtime on key tables

### HUD Pillars (5)

| Pillar | Scope | Status |
|--------|-------|--------|
| **Brand Memory** | Ingest, index, embed brand assets | Basic — run controls |
| **Creative Studio** | Generate + deliverables + prompt evolution | Live — DeliverableTracker + PromptEvolutionPanel |
| **Brand Drift** | Compliance scoring, drift metrics, baselines | Live — DriftAlertPanel + BaselinePanel |
| **Review Gate** | HITL review and approval | Live — ReviewPanel |
| **Insight Loop** | External intelligence (asset performance in the wild) | Not started |

---

## How to Run

```bash
nvm use                    # Node 22.x
npm run dev                # HUD at localhost:5173
npm run dev:api            # API at localhost:3001
npm run dev:all            # Both concurrently
```

**Brand engine sidecar** (when running pipeline):
```bash
cd brand-engine && python -m api.server   # FastAPI on :8100
```

**Worker** (headless runs):
```bash
cd worker && python worker.py
```

**Temp-gen sidecar** (when running pipeline):
```bash
cd ~/Temp-gen && python -m api.server   # FastAPI on :8200
```

**Temp-gen** (standalone CLI test):
```bash
cd ~/Temp-gen && python main.py nano generate   # Gemini 3 Pro Image
cd ~/Temp-gen && python main.py veo generate    # Veo 3.1
```

### Run Modes

| Mode | Description |
|------|-------------|
| `full` | Complete pipeline: ingest → generate → drift → hitl → export |
| `ingest` | Index brand assets only |
| `images` | Generate images only |
| `video` | Generate video only |
| `drift` | Run drift check only |
| `export` | Package artifacts |

---

## Supabase

**Project:** `tfbfzepaccvklpabllao`

**Tables (15):**
`clients`, `runs`, `run_logs`, `artifacts`, `hitl_decisions`, `rejection_categories`,
`campaigns`, `campaign_deliverables`, `campaign_memory`, `drift_metrics`, `drift_alerts`,
`brand_baselines`, `prompt_templates`, `prompt_scores`, `prompt_evolution_log`

**Realtime subscriptions:** `runs`, `run_logs`, `clients`, `campaigns`, `campaign_deliverables`,
`hitl_decisions`, `drift_metrics`, `drift_alerts`, `brand_baselines`

**Storage:** `artifacts` bucket for generated images/videos. Public URLs in artifacts table.
Optional Cloudinary CDN dual-write for platform-specific variants (10 presets).

**Migrations:** `supabase/migrations/001-006` — 001-005 applied, 006 pending (deliverable generation specs).

---

## Agent Delegation — Who Does What

### Brandy (you)
- Architecture decisions, code review, strategy
- Pipeline design, Supabase schema changes, migration writing
- Cross-repo coordination (wiring runner → brand-engine → Temp-gen)
- Reviewing Karl and Jackie's output before merging
- Roadmap updates: `~/agent-vault/domains/brandstudios/ROADMAP.md`

### Karl (Codex / GPT-5.4) — implementation lead
- **Frontend work** — React components, Tailwind styling, UI polish
- **API routes** — Express endpoint implementation in os-api/
- **Wiring tasks** — connecting existing backend to frontend (e.g., hook component to API)
- **Browser/computer use** — in-browser testing, visual verification, clicking through the HUD
- **Fast iteration** — when the spec is clear and it's build-not-design
- Karl runs in `~/proto_front` with full filesystem access

**Delegation pattern:**
```bash
agent-comm ask karl "In ~/proto_front, [specific task]. Files: [list]. 
Follow the patterns in [existing file]. Today is [date]."
```

### Jackie (Gemini / 3.1 Pro) — research + multimodal
- **Large context analysis** — reading entire codebases, audit docs, spec documents
- **Image/video analysis** — reviewing generated artifacts, brand compliance visual checks
- **Research synthesis** — comparing approaches, reading external docs
- **Brand asset review** — multimodal scoring of generated content against brand guidelines

**Delegation pattern:**
```bash
agent-comm ask jackie "Read [files/docs]. [Analysis question]. Today is [date]."
```

### Delegation Rules for This Repo
1. **Frontend components → Karl.** He has the best aesthetic output and fastest iteration.
2. **In-browser tasks → Karl.** Visual QA in the running HUD, clicking through flows, screenshots.
3. **Python work (brand-engine, worker) → Brandy.** Architecture-sensitive, needs context retention.
4. **Pipeline changes → Brandy architects, Karl implements.** Brandy designs the wiring, Karl writes the code.
5. **Visual QA on generated assets → Jackie.** She can see images natively.
6. **Never delegate Supabase schema or migration work.** Brandy owns data architecture.
7. **All Karl/Jackie output gets reviewed by Brandy before commit.**

---

## Rules

- `hud.json` is the source of truth for client/UI data — don't bypass it
- Tailwind v4 via Vite plugin — no PostCSS config needed
- Demo mode fallback when external tools unavailable (look for `[DEMO]` prefix)
- Pin all dependencies to exact versions
- This repo is NOT the dashboard — `~/brandstudios-dashboard/` is separate (standalone, Brandy + Tim only)

---

## Brand Identity

- Navy blue: `#15217C` (primary)
- Orange: `#ED4C14` (accent)
- Warm off-white: `#EFECEB` (background)
- Light editorial aesthetic — premium creative agency, AI-native

---

## Current State

See `~/agent-vault/domains/brandstudios/ROADMAP.md` for the full task backlog,
architecture coverage percentages, and what's next. That file is the live tracker.

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
│       ├── DeliverableTracker.tsx   ← Campaign deliverable lifecycle + shot L-badge/cost/click-to-drawer
│       ├── ShotDetailDrawer.tsx     ← Per-shot drawer — Narrative/Critic/Orchestrator/Timeline tabs (Chunk 2)
│       ├── WatcherSignalsPanel.tsx  ← Live SSE watcher — cost + loop alerts + cancel (Chunk 2)
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
├── supabase/migrations/    ← 8 migrations (001-008) — 007 adds known_limitations + asset_escalations + orchestration_decisions; 008 adds "regrade" to run_mode enum
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
| `images` | Generate images only (generic Temp-gen path) |
| `video` | Generate video only |
| `drift` | Run drift check only |
| `export` | Package artifacts |
| `regrade` | Re-grade existing artifacts via consensus critic + escalation loop, no fresh generation up-front |
| `stills` | **ADR-004 Phase B + Phase 4/5 calibration (2026-04-30).** Critic-in-loop on a campaign's stills. Body field `auditMode: true` runs parallel critics with a triage report (`runs.metadata.audit_report`); `auditMode: false` runs the per-shot critic→orchestrator→regen loop with degenerate-loop guard + $1.00/shot cost cap. Feature flag `STILLS_MODE_ENABLED` (default OFF). **Direction integrity:** when `manifest.directional_history` carries `current_direction_mantra` + `abandoned_directions[]`, the brand-engine critic emits a `## CAMPAIGN DIRECTION` axiom in its system prompt and the orchestrator sees `## ABANDONED DIRECTIONS` in its cache-stable system prefix. HARD RULE 6 (orch) escalates the level when a proposed prompt would re-introduce a rejected direction. Migration 012 added 4 image-class failure classes with `<<DEDUCT: criterion=-N.N, ...>>` markers parsed server-side (idempotent via tolerance check). Validated 2026-04-30 (re-audit run `a4aa3aff`): 5/6 drifted shots correctly flagged (83%, gate ≥80%); score drift collapse vs Phase B+ smoke #4. **Shot-beat-vs-mantra limitation:** when a manifest beat explicitly asks for an element that violates the campaign mantra in execution (e.g., shot 4: "rampaging mech + magical orb in palm"), critic prioritizes shot-beat intent. Operator workflow: review story arc, suggest alternative angle that fills the narrative gap without the conflict, log via `runs.metadata.operator_override`. Runbook: `docs/runbooks/stills-mode.md`. ADR-005 (`~/agent-vault/adr/005-campaign-branching-versioning.md`) captures the productized snapshot/branching architecture; lightweight precursor today via `productions/<slug>/checkpoint.sh`. |

---

## Supabase

**Project:** `tfbfzepaccvklpabllao` (Supabase project name `prototype_os_demo` — the legacy name predates the production framing pivot; the data IS production)
**Org:** `krjhaabsalqwjpebemmn`

### Authentication path (canonical 2026-04-29)

For ANY Supabase work — migrations, queries, MCP calls — use the **project-scoped Personal Access Token** in `os-api/.env`. Never go through global mcp.supabase.com OAuth; never use the user-shell `SUPABASE_ACCESS_TOKEN` env (it may be scoped to a different project).

```bash
# Canonical pattern — Supabase CLI with project-scoped PAT
PROTO_PAT=$(grep "^SUPABASE_ACCESS_TOKEN=" ~/proto_front/os-api/.env | cut -d= -f2-)

# One-time link (idempotent)
SUPABASE_ACCESS_TOKEN="$PROTO_PAT" supabase link --project-ref tfbfzepaccvklpabllao

# Apply migration / run SQL (use db query, NOT db push, for hand-written migration files)
SUPABASE_ACCESS_TOKEN="$PROTO_PAT" supabase db query --linked < supabase/migrations/NNN_*.sql

# Run ad-hoc SQL
SUPABASE_ACCESS_TOKEN="$PROTO_PAT" supabase db query --linked "SELECT ..."
```

Why not the MCP OAuth flow:
- The mcp.supabase.com OAuth path uses your browser cookies' Supabase account — risk of cross-account collisions
- The PAT in `os-api/.env` is scoped to this project + org; safer + no interactive flow
- Per supabase skill: use `execute_sql` (MCP) OR `supabase db query` (CLI), NOT `apply_migration` (writes migration history conflicts with `supabase db pull`)

The proto_front `.mcp.json` still exists for cases where a Brandy session needs the MCP toolset (advisors, branching, type generation), but for migrations + queries the CLI + PAT path is canonical.

**Tables (18):**
`clients`, `runs`, `run_logs`, `artifacts`, `hitl_decisions`, `rejection_categories`,
`campaigns`, `campaign_deliverables`, `campaign_memory`, `drift_metrics`, `drift_alerts`,
`brand_baselines`, `prompt_templates`, `prompt_scores`, `prompt_evolution_log`,
`known_limitations`, `asset_escalations`, `orchestration_decisions` (last 3 added in migration 007 for autonomous escalation).

**Realtime subscriptions:** `runs`, `run_logs`, `clients`, `campaigns`, `campaign_deliverables`,
`hitl_decisions`, `drift_metrics`, `drift_alerts`, `brand_baselines`

**Storage:** `artifacts` bucket for generated images/videos. Public URLs in artifacts table.
Optional Cloudinary CDN dual-write for platform-specific variants (10 presets).

**Migrations:** `supabase/migrations/001-007` — all applied (007 via Management API 2026-04-17).

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
- **`[DEMO]`-prefix offline fallback** is a runtime safeguard for external-tool outages (sidecar down, network failure). It is NOT a development mode. Real client onboarding never goes through this path; if a real run hits it, that's a P1 incident — open an `asset_escalations` row and fix the upstream tool.
- Pin all dependencies to exact versions
- This repo is NOT the dashboard — `~/brandstudios-dashboard/` is separate (standalone, Brandy + Tim only)

## Production posture (2026-04-29 canonical)

- **No "demo" framing.** This product is in production for client onboarding. The Drift MV music video is the inaugural campaign + the final training/implementation set for the agentic system that will run client work — it is real production output, not a deliverable for a presentation event. The May 4 milestone is the first client onboarding kickoff, not a demo.
- **Every commit ships at production rigor.** Tests, observability, documentation, error handling, cost monitoring, and rollback plan are all merge-blocking. "Get it working" is not enough — "get it production-ready" is the bar.
- **Critical-path sequencing.** Stills are SHIPPED end-to-end (30/30 in `campaign_deliverables`). The unblocking work for client onboarding is: (1) Phase C productization of the stills critic-in-loop pattern (`mode: "stills"` runner + `/grade_image_v2` endpoint — see ADR-004), (2) Veo motion phase for the reviewing video deliverables, (3) HUD operator polish for client work. None of these have demo scope — all are production.
- **Multi-client thinking.** Code paths must isolate per-campaign / per-client data. RLS in Supabase, audit log on all AI decisions (`orchestration_decisions` already does this), per-client cost ledger.

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

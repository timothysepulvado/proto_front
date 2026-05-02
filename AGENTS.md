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
│   ├── App.tsx             ← 5 pillar tabs, run controls, RunDetailDrawer mount
│   ├── api.ts              ← Supabase client, types, queries, realtime + Gap 1-8 helpers
│   ├── lib/supabase.ts     ← Supabase config
│   └── components/
│       ├── ReviewPanel.tsx                  ← HITL review UI
│       ├── ReviewGateEscalationSurface.tsx  ← Gap 1 — open/in-progress asset_escalations + Accept flow + Realtime
│       ├── DeliverableTracker.tsx           ← Campaign deliverable lifecycle + shot L-badge/cost/click-to-drawer + Gap 3 OPERATOR OVERRIDE pill + Gap 7 DIRECTION DRIFT pill
│       ├── AuditTriageTable.tsx             ← Audit triage (KEEP/L1/L2/L3/ERR/COST) + Gap 2 staleness banner
│       ├── ShotDetailDrawer.tsx             ← Per-shot drawer — Narrative/Critic/Orchestrator/Timeline + Gap 8 Iterations (5 tabs); Gap 3 override marker; Gap 7 Timeline-pinned-verdict
│       ├── RecentRunsPanel.tsx              ← Gap 4 — collapsible last-10-runs panel + filter toggle + Realtime by client_id
│       ├── RunDetailDrawer.tsx              ← Gap 4 — run drawer (logs + orch decisions + cost + artifacts)
│       ├── AnchorStillPanel.tsx             ← Stills + Anchors view + Gap 5 CANONICAL REF badges + per-shot canonical-ref footnotes
│       ├── ReshootPanel.tsx                 ← Reshoots/stills views + Gap 5 canonical-ref surfaces; Gap 6 hides legacy "Re-render Final Cut"
│       ├── MotionPhaseGate.tsx              ← Gap 6 — locked-stills aggregation + HITL block predicate + confirmation modal + mode:video CTA
│       ├── WatcherSignalsPanel.tsx          ← Live SSE watcher — cost + loop alerts + cancel
│       ├── DriftAlertPanel.tsx              ← Drift alerts + acknowledgment
│       ├── BaselinePanel.tsx                ← Brand baseline snapshots
│       ├── FinalHITLPanel.tsx               ← Full-edit HITL surface (Phase 2b)
│       ├── DeliverableTimeline.tsx          ← Horizontal-scrub deliverables timeline (Phase 2b)
│       └── PromptEvolutionPanel.tsx         ← Prompt performance + evolution
│
├── os-api/src/             ← Express API (orchestration layer)
│   ├── index.ts            ← Routes: runs, HITL, campaigns, deliverables, drift, prompts, productions, +
│   │                         Gap 1 PATCH /api/escalations/:id/resolve;
│   │                         Gap 4 GET /api/campaigns/:id/recent-runs + GET /api/runs/:id/detail;
│   │                         Gap 5 GET /api/productions/:slug/canonical-reference/:name;
│   │                         Gap 6 GET /api/campaigns/:id/motion-phase-gate;
│   │                         Gap 7 GET /api/campaigns/:id/direction-drift;
│   │                         Gap 8 GET /api/deliverables/:id/iterations + GET /api/artifacts/:id/file
│   ├── runner.ts           ← Pipeline executor — calls brand-engine :8100 + Temp-gen :8200
│   ├── stills_runner.ts    ← `mode:stills` audit-mode + in-loop critic-in-loop pipeline (Phase B + B+ #1-#8)
│   ├── orchestrator.ts     ← Opus 4.7 orchestration; HARD RULES 1-7 (Rule 7 = 2000-char prompt budget)
│   ├── escalation_loop.ts  ← L1/L2/L3 escalation w/ stills-specific $1.00/shot cap
│   ├── productions.ts      ← Production manifest endpoints + Gap 5 canonical_reference normalization in mapManifestShotToResponse
│   ├── db.ts               ← Supabase query layer, typed mappers + Gap 4-8 typed aggregators (recent-runs, motion-gate state, direction-drift indicators, artifact iterations)
│   ├── types.ts            ← Shared types (Run, Artifact, Campaign, DriftAlert, MotionPhaseGate, DirectionDriftIndicator, ArtifactIterationRow, etc.)
│   ├── storage.ts          ← Supabase Storage upload (dual-write to Cloudinary)
│   ├── cloudinary.ts       ← Optional CDN — 10 platform presets
│   └── tests/              ← Per-gap typed test suites: _gap4-recent-runs, _gap5-canonical-reference, _gap6-motion-phase-gate, _gap7-direction-drift, _gap8-artifact-iterations + _10d-shot-summaries (16/16) + phase-b-stills-runner (14/14)
│
├── worker/                 ← Python worker (headless run execution)
│   ├── worker.py           ← Polls Supabase for runs (filtered: not in OS_API_OWNED_MODES)
│   ├── config.py           ← Worker config
│   └── executors/          ← Stage executors (ingest, grading, prompt_evolver)
│
├── brand-engine/           ← Python SDK (consolidated from Brand_linter + BDE)
│   ├── brand_engine/core/  ← 7 modules: embeddings, retrieval, drift, fusion, trainer
│   ├── api/server.py       ← FastAPI sidecar on :8100 (X-Trace-Id passthrough on /grade_image_v2)
│   └── cli/main.py         ← CLI interface
│
├── supabase/migrations/    ← 12 migrations (001-012). Highlights: 007 known_limitations + asset_escalations + orchestration_decisions; 008 adds "regrade" to run_mode enum; 009 stills failure-class catalog; 010 stills enum value; 011 runs.metadata JSONB (audit_report + operator_override); 012 image-class failure classes for direction-drift detection
├── output/playwright/      ← Visual QA captures — 28 post-direction-fix-pass-gap{1..8}-{1440,768,375}.png + variants (compare/enabled/blocked/collapsed)
├── hud.json                ← Client data + UI config (source of truth)
└── docs/                   ← Integration audit, tech requirements, runbooks/stills-mode.md
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
| `stills` | **ADR-004 Phase B + Phase 4/5 calibration + Phase B+ #1-#8 (2026-04-30).** Critic-in-loop on a campaign's stills, validated end-to-end on the drift-mv direction-fix. Body field `auditMode: true` runs parallel critics with a triage report (`runs.metadata.audit_report`); `auditMode: false` runs the per-shot critic→orchestrator→regen loop with degenerate-loop guard + $1.00/shot cost cap. Body field `shotIds: number[]` (Phase B+ #5) provides operator-controlled targeted regen — bypasses the default `status NOT IN (approved, rejected)` filter and iterates exactly the listed manifest shot IDs. Feature flag `STILLS_MODE_ENABLED` (default OFF). **Direction integrity:** when `manifest.directional_history` carries `current_direction_mantra` + `abandoned_directions[]`, the brand-engine critic emits a `## CAMPAIGN DIRECTION` axiom in its system prompt and the orchestrator sees `## ABANDONED DIRECTIONS` in its cache-stable system prefix. HARD RULE 6 (orch) escalates the level when a proposed prompt would re-introduce a rejected direction. **HARD RULE 7 (Phase B+ #5, 2026-04-30):** orchestrator must keep `new_still_prompt` and `new_veo_prompt` ≤ 2000 chars (NB Pro hard ceiling — Temp-gen returns HTTP 500, brand-engine pre-flight returns HTTP 422 for over-budget prompts). Defensive truncation in `orchestrator.ts::_enforcePromptBudget()` cuts at the last sentence terminator before 1990 chars when the model ignores doctrine; emits `[orchestrator] truncated` warn for HITL signal. **Loop closure (Phase B+ #6):** the in-loop runner closes regen → artifact → re-grade fully. After Temp-gen writes a regen still, `createArtifactWithUpload` registers it tied to (current run, current deliverable, iter+1) with `metadata.parentArtifactId` provenance; next iter's `getArtifactsByRun` picks it up and the critic re-grades the new image. Runner reads `candidate.metadata.localPath` first (Phase B+ #7) so the local-file grader can find the disk copy when `path` is the public Storage URL. **Auto-seed (Phase B+ #3):** when no artifact exists for a (current run, deliverable) pair but a prior-run artifact OR an on-disk locked still exists, the runner registers a synthetic seed artifact with `metadata.seededFromArtifactId` + `metadata.seedReason` so escalation can attach. **HITL bubble (Phase B+ #8):** when `handleQAFailure` returns `outcome: "hitl_required"`, the runner sets `runs.hitl_required = true` + writes a `hitl_notes` summary. Same pattern in video pipeline (`runner.ts` line 605 area). The asset_escalations row is the canonical signal; the runs flag is the indexable bubble for HUD queries. **X-Trace-Id passthrough (Phase B+ #2):** brand-engine `/grade_image_v2` route reads the `X-Trace-Id` request header and binds it to a per-request ContextVar in `image_grader.py` so emitted `critic_call` metrics carry the caller's trace ID instead of a fresh-per-call uuid. **Operator override pattern:** when the critic flags FAIL but the operator's visual review accepts the asset (intent-vs-mantra cases like shot 4; critic-variance cases like shot 7 with 3.17/3.92/4.90 scores on the same image), the override is recorded to `runs.metadata.operator_override.shot_<id>` with `decision_at` + `decision_by` + `decided_artifact_path` + `decided_iter` + `critic_verdict` + `critic_score` + `rationale` + `locked_to`. Validated 2026-04-30 closing run `01ead7d8-...` (5 shots: 2 SHIP / 1 ACCEPT / 2 HITL → operator override) + `214265e2-...` (shot 20 v5 iter3 lock). Migration 012 added 4 image-class failure classes with `<<DEDUCT: criterion=-N.N, ...>>` markers parsed server-side (idempotent via tolerance check). **Shot-beat-vs-mantra limitation:** when a manifest beat explicitly asks for an element that violates the campaign mantra in execution (e.g., shot 4: "rampaging mech + magical orb in palm"), critic prioritizes shot-beat intent. Operator workflow: review story arc, suggest alternative angle that fills the narrative gap without the conflict, log via `runs.metadata.operator_override`. **Canonical character references:** `manifest.characters.<name>.canonical_reference_still` (Phase B+ extension, 2026-04-30) — locked still that serves as the visual ground-truth for that character in future regens. Currently set: `mech_openai.canonical_reference_still = "stills/shot_07.png"`. Runbook: `docs/runbooks/stills-mode.md`. ADR-005 (`~/agent-vault/adr/005-campaign-branching-versioning.md`) captures the productized snapshot/branching architecture; lightweight precursor used in production today via `productions/<slug>/checkpoint.sh`. |

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

### Karl (Codex / GPT-5.5 xhigh) — implementation lead
- **Frontend work** — React components, Tailwind styling, UI polish
- **API routes** — Express endpoint implementation in os-api/
- **Wiring tasks** — connecting existing backend to frontend (e.g., hook component to API)
- **Browser/computer use** — in-browser testing, visual verification, clicking through the HUD
- **Fast iteration** — when the spec is clear and it's build-not-design
- Karl runs in `~/proto_front` with full filesystem access

**Karl's runtime — the canonical mechanism (locked-in 2026-04-30, hardened 2026-05-02):**

Karl runs as a **persistent codex TUI in tmux pane `brandy-proto_front:agents.2`**, launched via start-brandy.sh as `codex -p karl-max`. The `-p karl-max` flag is **non-negotiable** — without it codex starts with raw defaults (no YOLO, no full-access sandbox), Karl will hit a permission prompt the moment he tries to write/commit/push, and someone has to babysit. Always launch with the profile.

**What `-p karl-max` actually pins (per `~/.codex/config.toml`):**
- `model = "gpt-5.5"` (current latest — bump this in config.toml when OpenAI ships next-gen; not auto)
- `model_reasoning_effort = "xhigh"` (extra-high reasoning depth)
- `approval_policy = "never"` (= YOLO — no per-tool prompts)
- `sandbox_mode = "danger-full-access"` (= file writes anywhere, network, npm, git push without prompts)
- `web_search = "cached"` (live web search via `karl-research` profile)
- `model_instructions_file = ~/.codex/karl-instructions.md` (loads vault protocol, status save, daily-log appends)

Brandy dispatches by sending keys into that existing TUI session via `agent-comm`:

```bash
agent-comm send karl "In ~/proto_front, [specific task]. Files: [list].
Follow the patterns in [existing file]. Today is [date]."

# Status / read helpers
agent-comm status karl                              # idle | busy | unknown
agent-comm last karl                                # most recent screen capture
tmux capture-pane -t brandy-proto_front:agents.2 -p # full pane snapshot
```

**Brandy session env note:** `agent-comm`'s session detection falls through to `brandy-brandy-agent-team` if `BRANDY_SESSION` is unset AND the working directory's basename doesn't match its case statement (proto_front, brandstudios-dashboard, brandstudios-landing, brandy-agent-team, personal, thegroupproject, Teach). When Brandy is `cd`'d into a subdirectory like `~/proto_front/brand-engine`, the basename `brand-engine` falls through and `agent-comm` reports `can't find session: brandy-brandy-agent-team`. Fix: write a session marker so subsequent calls resolve correctly:

```bash
echo "brandy-proto_front" > ~/agent-vault/streams/.session
# Or set per-call: BRANDY_SESSION=brandy-proto_front agent-comm send karl "..."
```

The marker is read on every `agent-comm` invocation if `BRANDY_SESSION` env is unset.

**DO NOT raw-spawn `codex exec --ephemeral` from Brandy's Bash tool to dispatch Karl.** Burned 2 hours of session time on this 2026-04-30: the codex app-server daemon caches workdir state across invocations, and ephemeral sessions inherit that state instead of `-C` + inline `BRANDY_DOMAIN` env vars. Result: Karl repeatedly landed in whichever domain's repo had the most-recent codex app-server activity (e.g., teachce-portal), not `proto_front`. The TUI panel + agent-comm bypasses this entirely — same persistent session, same workdir, same auth state.

**Verifying Karl is actually alive — DON'T trust `agent-comm status` alone (lesson learned 2026-05-01 PM):**

`agent-comm status karl` reads from a state file the script maintains itself. It can return `idle` even when the codex TUI process inside pane 2 has exited and the pane is back at a bare zsh prompt. Same for `agent-comm last karl` — it returns the last captured screen, which can be HOURS stale.

Three signals must ALL agree before assuming Karl is alive:

```bash
# 1. Script status (necessary but not sufficient)
agent-comm status karl  # must say "idle" or "busy"

# 2. Process check — confirm a codex binary is actually running
ps aux | grep -E 'codex.*karl-max' | grep -v grep
# Must show a recent codex process (PID + start time). If empty → DEAD.

# 3. Send a fresh ping and watch the scrollback for a response within 10-15s
agent-comm send karl "Brandy: health check. Reply 'alive' and nothing else."
sleep 12
tmux capture-pane -t brandy-proto_front:agents.2 -p -S -100 | tail -25
# Must show "› Brandy: health check..." input + "• alive" response.
# If the ping doesn't appear in the scrollback → keys aren't landing → DEAD.
```

**Gotchas exposed in the same session:**
- `tmux list-panes -F '#{pane_current_command}'` shows the parent shell command (e.g., `node` for the parent shell that spawned codex, OR `-zsh` if codex died) — NOT the foreground codex TUI. Don't use this as a liveness signal.
- `tmux capture-pane -p` (no `-S`) may render empty when codex uses alternate-screen mode; always use `-S -100` to grab scrollback.
- The `agent-comm last karl` output frequently lags reality by hours. Always cross-check against a fresh ping response.

**If Karl's panel is dead** (pane shows plain `zsh`, ps shows no codex process, OR ping doesn't get a response):

```bash
# CRITICAL: only run this if codex is NOT already running. If codex is alive,
# `tmux send-keys "codex -p karl-max" Enter` will type that string AS A PROMPT
# inside the TUI (Karl will think you're asking him to launch codex-in-codex).
# Verify with the `ps aux` check above first.

tmux send-keys -t brandy-proto_front:agents.2 "codex -p karl-max" Enter
sleep 14  # codex bootstrap — 8-14s
tmux capture-pane -t brandy-proto_front:agents.2 -p -S -100 | tail -15
```

**Banner verification — ALL THREE lines must be present (lesson learned 2026-05-02):**

```
╭──────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.128.0)                   │
│                                              │
│ model:       gpt-5.5 xhigh                   │  ← model + reasoning effort
│ directory:   ~/proto_front                   │  ← cwd
│ permissions: YOLO mode                       │  ← profile loaded ✓
╰──────────────────────────────────────────────╯
```

If `permissions: YOLO mode` is **missing** from the banner, the `karl-max` profile did NOT load. Karl will hit prompts on the first write/commit/push. **Stop-the-world condition** — kill the codex (Ctrl-C twice or `q` to quit), then re-launch with the explicit `-p karl-max` flag:

```bash
tmux send-keys -t brandy-proto_front:agents.2 C-c C-c  # quit codex cleanly
sleep 2
tmux send-keys -t brandy-proto_front:agents.2 "codex -p karl-max" Enter
sleep 14
tmux capture-pane -t brandy-proto_front:agents.2 -p -S -100 | tail -15
# Verify ALL THREE banner lines including "permissions: YOLO mode"
```

**Common mistakes that strip YOLO:**
- Typing just `codex` instead of `codex -p karl-max` (uses raw defaults, no profile)
- Codex prompted for sign-in (device-code OAuth flow) — after sign-in the profile may not auto-apply; verify the banner
- Profile config.toml was edited mid-session (codex caches profile state per-process; restart picks up changes)

Then dispatch via agent-comm as usual.

**Keeping Karl on the newest model:** the `karl-max` profile pins `model = "gpt-5.5"` literally. When OpenAI ships gpt-5.6 / gpt-6 / next-gen, the `model = ` line in `~/.codex/config.toml` must be manually bumped. The Codex CLI binary itself auto-updates via `start-brandy.sh:update_agents()` (npm install -g @openai/codex@latest), but the model name in the profile does not. After bumping config.toml, restart any running Karl panel to pick up the new model.

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

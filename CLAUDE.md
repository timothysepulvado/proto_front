# BrandStudios OS - Claude Context

Quick reference for Claude Code sessions working on this codebase.

## Project Overview

BrandStudios is a multi-component system for brand-consistent AI image generation:

| Component | Location | Purpose |
|-----------|----------|---------|
| **HUD** | `~/Hud` | Frontend dashboard + Python workers |
| **Brand_linter** | `~/Desktop/Brand_linter/local_quick_setup` | Triple fusion scoring (CLIP + E5 + Cohere) |
| **BDE** | `~/BDE` | Brand DNA Engine, RL threshold tuning |
| **Temp-gen** | `~/Temp-gen` | Image generation (Veo/Nano/Sora) |

## Active Branches

| Repository | Branch | Purpose |
|-----------|--------|---------|
| HUD | `tim-dev` | Main development (Phase 7) |
| Brand_linter | `phase-3` | Triple fusion scoring |
| BDE | `antigravity` | RL threshold tuning |
| Temp-gen | `main` | Image generation |

## Critical Naming Contract

**MUST READ: `worker/index_guard.py`** - All index/naming logic is centralized here.

### Brand Identifiers

| Identifier | Format | Example | Used Where |
|------------|--------|---------|------------|
| `brand_id` | lowercase, underscores OK | `jenni_kayne` | Supabase FKs, logs, UI |
| `brand_slug` | lowercase, NO underscores | `jennikayne` | Pinecone index names ONLY |
| `client_id` | `client_` + brand_id | `client_jenni_kayne` | Supabase `clients.id` PK |

**Derivation:** `brand_slug = brand_id.replace("_", "").lower()`

### Pinecone Index Names

Pattern: `{brand_slug}-{type}-{model}{dimension}`

| Type | Purpose | Example |
|------|---------|---------|
| `core` | Canonical brand DNA (READ for grading) | `jennikayne-core-clip768` |
| `campaign` | AI-approved outputs (WRITE target) | `jennikayne-campaign-clip768` |
| `brand-dna` | LEGACY - treat as core | `jennikayne-brand-dna-clip768` |

### Hard Walls (Safety Guards)

```python
from index_guard import assert_grading_index, assert_ai_write_index

# GRADING: Must read from Core/legacy indexes
assert_grading_index(index_name)  # Raises on campaign indexes

# AI WRITES: Must write to Campaign indexes
assert_ai_write_index(index_name)  # Raises on core/legacy indexes
```

### Score Variable Naming

| Suffix | Scale | Example |
|--------|-------|---------|
| `_raw` | 0.0 - 1.0 | `clip_raw = 0.693` |
| `_z` | unbounded | `clip_z = +1.2` |

**Always use suffixes** - bare `clip`, `e5`, etc. are ambiguous.

## Directory Structure

```
~/Hud/
├── src/                      # React frontend
│   ├── App.tsx               # Main app with modals
│   ├── api.ts                # Supabase API functions
│   └── components/           # React components
├── worker/
│   ├── worker.py             # Main polling worker
│   ├── index_guard.py        # Naming contract enforcement
│   ├── config.py             # Environment config
│   ├── executors/            # Legacy executors
│   └── workers/              # Phase 6.5+ workers
│       ├── orchestrator.py   # Campaign loop
│       ├── scoring_worker.py # BDE scoring
│       ├── dna_updater.py    # Pinecone ingestion
│       ├── generation_worker.py
│       └── prompt_modifier.py
├── supabase/migrations/      # Database schema
│   ├── 001_initial_schema.sql
│   ├── 002_campaigns_and_config.sql
│   ├── 003_campaigns_v2.sql
│   ├── 004_drift_metrics.sql
│   └── 005_add_brand_slug.sql
└── HANDOFF.md                # Detailed session handoff
```

## Current Phase: 7 (Frontend Integration)

- Backend workers are built (Phase 6.5)
- Frontend needs wiring to new orchestrator
- See `HANDOFF.md` for detailed status

## Key Commands

```bash
# Run frontend
cd ~/Hud && npm run dev

# Run worker
cd ~/Hud/worker && python worker.py

# Test index_guard
cd ~/Hud/worker && python -c "from index_guard import *; print(get_brand_slug('jenni_kayne'))"
```

## Important Files to Read First

1. `worker/index_guard.py` - Naming contract
2. `HANDOFF.md` - Current status and next steps
3. `supabase/migrations/003_campaigns_v2.sql` - Current schema
4. `worker/workers/orchestrator.py` - Campaign loop architecture

## Gotchas

1. **pinecone_namespace bug**: Supabase stores `jenni_kayne` but indexes use `jennikayne`. Use `index_guard.get_brand_slug()`.

2. **Score variables**: Old code uses `clip_score`, new code should use `clip_raw` or `clip_z`.

3. **Legacy indexes**: `{brand}-brand-dna-*` are treated as Core for grading.

4. **Client ID format**: Supabase PKs are `client_jenni_kayne`, not just `jenni_kayne`.

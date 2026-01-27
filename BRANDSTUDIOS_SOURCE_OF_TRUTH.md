# BrandStudios OS - Source of Truth

**Last Updated:** 2026-01-21
**Version:** 1.0

This document is THE definitive reference for naming conventions, architecture, and system rules. All code, docs, and data must conform to these specifications.

---

## Part 1: The Naming Contract

### Rule 1: Brand Identifiers

| Identifier | Format | Example | Used Where |
|------------|--------|---------|------------|
| `brand_id` | lowercase, underscores OK | `jenni_kayne` | Supabase FKs, logs, UI display |
| `brand_slug` | lowercase, NO underscores | `jennikayne` | Pinecone index names ONLY |
| `client_id` | `client_` + brand_id | `client_jenni_kayne` | Supabase `clients.id` PK |

**Derivation Rule:**
```python
brand_slug = brand_id.replace("_", "").replace(" ", "").lower()
```

**Verification:** `get_brand_slug("jenni_kayne")` MUST return `"jennikayne"`

**Implementation:** `worker/index_guard.py`

---

### Rule 2: Pinecone Index Names

**Pattern:** `{brand_slug}-{type}-{model}{dimension}`

| Component | Values | Notes |
|-----------|--------|-------|
| `brand_slug` | `jennikayne`, `cylndr`, etc. | NO underscores |
| `type` | `core` or `campaign` | Hard wall separation |
| `model` | `clip`, `e5`, `cohere` | Embedding model |
| `dimension` | `768`, `1024`, `1536` | Must match model |

**Model-Dimension Mapping:**

| Model | Dimension | Example Index |
|-------|-----------|---------------|
| CLIP | 768 | `jennikayne-core-clip768` |
| E5 | 1024 | `jennikayne-core-e5-1024` |
| Cohere | 1536 | `jennikayne-core-cohere1536` |

**Legacy Indexes (treat as Core during migration):**
- `jennikayne-brand-dna-clip768` → treat as Core
- `jennikayne-brand-dna-e5` → treat as Core
- `jennikayne-brand-dna-cohere` → treat as Core

**Verification:** Index names MUST match regex: `^[a-z]+-(?:core|campaign|brand-dna)-(?:clip768|e5-1024|e5|cohere1536|cohere)$`

---

### Rule 3: Index Access Rules (Hard Walls)

| Operation | Core Indexes | Campaign Indexes |
|-----------|--------------|------------------|
| Grading/Scoring | ✅ READ | ❌ NEVER |
| AI Output Writes | ❌ NEVER | ✅ WRITE |
| Drift Analysis | ✅ READ | ✅ READ |
| Manual Curation | ✅ WRITE (admin) | ❌ NEVER |

**Enforcement Functions:**
- `assert_grading_index()` MUST raise on campaign indexes
- `assert_ai_write_index()` MUST raise on core/legacy indexes

**Implementation:** `worker/index_guard.py`

---

### Rule 4: Score Variable Names

| Suffix | Scale | Meaning | Example |
|--------|-------|---------|---------|
| `_raw` | 0.0 - 1.0 | Raw cosine similarity | `clip_raw = 0.693` |
| `_z` | unbounded | Z-score normalized | `clip_z = +1.2` |
| (none) | context-dependent | AVOID - ambiguous | `clip = ???` |

**Required Variables:**
```python
# Raw scores (from Pinecone query)
clip_raw: float    # 0.0 - 1.0
e5_raw: float      # 0.0 - 1.0
cohere_raw: float  # 0.0 - 1.0

# Z-normalized scores
clip_z: float      # unbounded
e5_z: float        # unbounded
cohere_z: float    # unbounded

# Fused score (always z-normalized)
fused_z: float     # unbounded
```

**Verification:** Code search for `/\b(clip|e5|cohere|fused)(?!_raw|_z)\b/` should return 0 matches in new code.

---

### Rule 5: Database Schema

**clients table:**

| Column | Type | Example | Notes |
|--------|------|---------|-------|
| `id` | TEXT PK | `client_jenni_kayne` | Uses `client_` prefix |
| `brand_slug` | TEXT | `jennikayne` | URL-safe for Pinecone |
| `pinecone_namespace` | TEXT | `jenni_kayne` | **DEPRECATED** - kept for backwards compat |

**Verification:** `clients.brand_slug` MUST equal `get_brand_slug(brand_id)` for all rows.

---

### Rule 6: Function Naming in index_guard.py

| Function | Input | Output | Purpose |
|----------|-------|--------|---------|
| `get_brand_slug(brand_id)` | `"jenni_kayne"` | `"jennikayne"` | Convert brand_id to slug |
| `get_core_index(brand_id, model)` | `"jenni_kayne", "clip"` | `"jennikayne-core-clip768"` | Get Core index name |
| `get_campaign_index(brand_id, model)` | `"jenni_kayne", "clip"` | `"jennikayne-campaign-clip768"` | Get Campaign index name |
| `assert_grading_index(index)` | `"jennikayne-campaign-clip768"` | RAISES | Prevent grading from Campaign |
| `assert_ai_write_index(index)` | `"jennikayne-core-clip768"` | RAISES | Prevent AI writes to Core |

---

## Part 2: System Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              HUD (~/Hud)                                │
├─────────────────────────────────────────────────────────────────────────┤
│  Frontend (React)           │  Workers (Python)                         │
│  - Campaign Setup Modal     │  - Orchestrator (campaign loop)           │
│  - HITL Review Panel        │  - Scoring Worker (BDE/Brand Linter)      │
│  - Artifact Gallery         │  - DNA Updater (Pinecone ingestion)       │
│  - Run Feed (logs)          │  - Generation Worker (Temp-gen)           │
└────────────────┬────────────┴───────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Supabase                                       │
├─────────────────────────────────────────────────────────────────────────┤
│  clients │ campaigns │ campaign_deliverables │ artifacts │ hitl_decisions│
│  runs    │ run_logs  │ campaign_memory       │ drift_metrics            │
└─────────────────────────────────────────────────────────────────────────┘
                 │
      ┌──────────┼──────────┐
      ▼          ▼          ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│ Brand    │ │   BDE    │ │ Temp-gen │
│ Linter   │ │          │ │          │
│          │ │ RL/HITL  │ │ Veo/Nano │
│ Scoring  │ │ Tuning   │ │ Sora     │
└──────────┘ └──────────┘ └──────────┘
      │          │
      ▼          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Pinecone Indexes                                 │
├─────────────────────────────────────────────────────────────────────────┤
│  CORE (read for grading)        │  CAMPAIGN (write AI outputs)          │
│  jennikayne-core-clip768        │  jennikayne-campaign-clip768          │
│  jennikayne-core-e5-1024        │  jennikayne-campaign-e5-1024          │
│  jennikayne-core-cohere1536     │  jennikayne-campaign-cohere1536       │
├─────────────────────────────────┴─────────────────────────────────────────┤
│  LEGACY (treat as Core)                                                   │
│  jennikayne-brand-dna-clip768 │ jennikayne-brand-dna-e5 │ *-cohere       │
└─────────────────────────────────────────────────────────────────────────┘
```

### Campaign Flow (Phase 6.5+)

```
┌─────────────────────────────────────────────────────────────────┐
│ CAMPAIGN SETUP (HUD - "+" button → Campaign Setup V2)           │
│ - Mode: Campaign (guardrails) vs Creative (flexible)            │
│ - Deliverables: poses × models × outfits                        │
│ - Max retries: configurable (default 3)                         │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ ORCHESTRATOR (Python worker/workers/orchestrator.py)            │
│ - Short-term memory for rejection tracking                      │
│ - Coordinates generation, scoring, routing                      │
└─────────────────────────────────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
   ┌─────────┐            ┌─────────┐            ┌─────────┐
   │ Generate│            │  Score  │            │  Route  │
   │ (Temp-  │───────────▶│  (BDE)  │───────────▶│ Pass/   │
   │  gen)   │            │  CORE   │            │  Fail   │
   └─────────┘            └─────────┘            └────┬────┘
                                                      │
                    ┌─────────────────────────────────┼─────────┐
                    ▼                                 ▼         ▼
              ┌──────────┐                     ┌──────────┐ ┌───────┐
              │   HITL   │                     │  Retry   │ │ Flag  │
              │  Queue   │                     │  Batch   │ │Manual │
              └────┬─────┘                     └────┬─────┘ └───────┘
                   │                                │
                   ▼                                │
              ┌──────────┐                          │
              │  Human   │──── Reject ─────────────►│
              │  Review  │                          │
              └────┬─────┘                          │
                   │ Approve                        │
                   ▼                                │
              ┌──────────┐                          │
              │ CAMPAIGN │◄── Modified prompts ─────┘
              │  INDEX   │ (AI writes approved outputs)
              └──────────┘
```

---

## Part 3: File Reference

### Core Implementation Files

| File | Purpose | Status |
|------|---------|--------|
| `worker/index_guard.py` | Naming contract enforcement | ✅ Active |
| `worker/workers/orchestrator.py` | Campaign loop coordinator | ✅ Built |
| `worker/workers/scoring_worker.py` | BDE triple fusion scoring | ✅ Built |
| `worker/workers/dna_updater.py` | Pinecone ingestion | ✅ Built |
| `worker/workers/generation_worker.py` | Temp-gen interface | ✅ Built |
| `worker/workers/prompt_modifier.py` | Rejection → prompt mapping | ✅ Built |

### Database Migrations

| Migration | Purpose | Status |
|-----------|---------|--------|
| `001_initial_schema.sql` | Core tables (clients, runs, artifacts) | ✅ Applied |
| `002_campaigns_and_config.sql` | Campaigns, HITL decisions | ✅ Applied |
| `003_campaigns_v2.sql` | Deliverables, campaign memory | ✅ Applied |
| `004_drift_metrics.sql` | Drift tracking tables | 🔄 Ready |
| `005_add_brand_slug.sql` | Fix brand_slug in clients | 🔄 Ready |

### Frontend Components

| Component | File | Status |
|-----------|------|--------|
| Campaign Setup Modal | `src/components/CampaignSetupModal.tsx` | ✅ Built, needs wiring |
| Deliverable Builder | `src/components/DeliverableBuilder.tsx` | ✅ Built, needs wiring |
| HITL Review Panel | `src/components/HITLReviewPanel.tsx` | ✅ Active |
| Artifact Gallery | `src/components/ArtifactGallery.tsx` | ✅ Active |

---

## Part 4: Phase Roadmap

### Completed Phases

| Phase | Description | Status |
|-------|-------------|--------|
| 1-2 | HUD core + Campaign V1 | ✅ |
| 3 | Cohere v4, triple fusion | ✅ |
| 4 | CLIP index fix | ✅ |
| 5 | ID alignment across indexes | ✅ |
| 6 | HITL/RL integration | ✅ |
| 6.5 | Backend workers (orchestrator, scoring) | ✅ |

### Current Phase

| Phase | Description | Status |
|-------|-------------|--------|
| 7 | Frontend integration with new workers | 🔄 In Progress |

### Future Phases

| Phase | Description | Status |
|-------|-------------|--------|
| 8 | Core/Campaign index migration | 📋 Planned |
| 9 | Drift monitoring & alerts | 📋 Planned |
| 10 | Production deployment | 📋 Planned |

---

## Part 5: Verification Checklist

Before any code is merged, verify:

- [ ] All index names match Rule 2 pattern
- [ ] All workers use `index_guard.py` (not hardcoded names)
- [ ] `scoring_worker.py` calls `assert_grading_index()` before reading
- [ ] `dna_updater.py` calls `assert_ai_write_index()` before writing
- [ ] All score variables use `_raw` or `_z` suffix (Rule 4)
- [ ] `clients.brand_slug` column exists and is populated correctly
- [ ] Unit tests pass for `index_guard.py` functions

---

## Part 6: Quick Reference

### Scoring Thresholds

| Decision | Fused Score |
|----------|-------------|
| AUTO_PASS | ≥ 0.92 |
| HITL_REVIEW | ≥ 0.50 |
| AUTO_FAIL | < 0.50 |

### Rejection Categories

```
too_dark, too_bright, wrong_colors, off_brand, wrong_composition,
cluttered, wrong_model, wrong_outfit, quality_issue, other
```

### AI Models

| Model | Type | Timeout |
|-------|------|---------|
| Nano | Image (fast) | 120s |
| Veo | Video | 300s |
| Sora | Image (premium) | 180s |

### Per-Client Config

| Client | brand_id | brand_slug | Storage |
|--------|----------|------------|---------|
| Jenni Kayne | `jenni_kayne` | `jennikayne` | Cloudinary |
| Lilydale | `lilydale` | `lilydale` | Cloudinary |
| Cylndr | `cylndr` | `cylndr` | S3 |

---

## Part 7: Common Operations

### Test index_guard.py

```bash
cd ~/Hud/worker
python -c "
from index_guard import get_brand_slug, get_core_index, get_campaign_index
assert get_brand_slug('jenni_kayne') == 'jennikayne'
assert get_core_index('jenni_kayne', 'clip') == 'jennikayne-core-clip768'
assert get_campaign_index('jenni_kayne', 'e5') == 'jennikayne-campaign-e5-1024'
print('✅ All tests pass')
"
```

### Run HUD

```bash
# Terminal 1 - Worker
cd ~/Hud/worker && python worker.py

# Terminal 2 - Frontend
cd ~/Hud && npm run dev
```

### Apply Migrations

```bash
# After creating new migration files, apply via Supabase CLI or dashboard
supabase db push
```

---

## Repository Branches

### Active Development Branches

| Repo | Branch | Purpose | Sync Status |
|------|--------|---------|-------------|
| HUD | `tim-dev` | Frontend + worker development | Active |
| Brand_linter | `phase-3` | Scoring engine | Stable |
| BDE | `antigravity` | RL tuning | Stable |
| Temp-gen | `main` | Generation models | Stable |

### Branch Naming Convention
- `tim-dev` - Tim's development branch
- `phase-N` - Phase-specific feature branches
- `main` - Stable/production code

---

*This document is the single source of truth. When in doubt, refer here.*

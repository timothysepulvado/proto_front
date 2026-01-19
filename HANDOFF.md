# BrandStudios OS - Session Handoff

**Last Updated:** 2026-01-18
**Branch:** `tim-dev`
**Status:** Phase 6 Complete (HITL/RL Integration) | HUD Phase 2 Complete

---

## System-Wide Component Status

| Component | Location | Branch | Phase | Health | Notes |
|-----------|----------|--------|-------|--------|-------|
| **HUD** | `~/Hud` | `tim-dev` | Phase 2 ✅ | 9/10 | HITL → Supabase → BDE connected |
| **Brand_linter** | `~/Desktop/Brand_linter/local_quick_setup` | `phase-3` | Phase 5 ✅ | 10/10 | Triple fusion fully operational |
| **BDE** | `~/BDE` | `antigravity` | Phase 6 ✅ | 10/10 | HITL/RL integration complete |
| **Temp-gen** | `~/Temp-gen` | - | Phase 2 ✅ | 7/10 | Veo/Nano/Sora working |

---

## Phase 6 Completion Summary (2026-01-18)

### HITL/RL Integration with BDE

Connected HUD's human feedback (stored in Supabase) to BDE's threshold calibration system.

#### What Was Done

1. **Created HITLStore Abstraction** (`BDE/services/ml-worker/core/hitl_store.py`)
   - Portable data access layer (Supabase now, RDS-ready later)
   - Methods: `get_decisions()`, `get_approval_stats()`, `get_score_distribution()`
   - Handles `client_jenni_kayne` vs `jenni_kayne` ID formats

2. **Rewrote RL Trainer** (`BDE/tools/rl_trainer.py`)
   - Reads from HUD's Supabase `hitl_decisions` table via HITLStore
   - Adjusts `auto_pass_floor` and `rag_similarity_min` thresholds
   - CLI: `--brand`, `--days`, `--dry-run`, `--verbose`, `--list-brands`

3. **Configuration**
   - Added `supabase>=2.0.0` to BDE requirements
   - Added `SUPABASE_URL` and `SUPABASE_KEY` to BDE .env

#### Data Flow
```
HUD Frontend ──► Supabase (hitl_decisions) ──► HITLStore ──► RL Trainer
     │           (writes decisions)            (reads)       (calibrates)
     │                                                            │
     └── User approves/rejects artifacts ─────────────────────────┘
                                              brand_profiles.json updated
```

#### Usage
```bash
# In BDE directory
python tools/rl_trainer.py --brand jenni_kayne --dry-run -v  # Preview
python tools/rl_trainer.py --brand jenni_kayne               # Apply
```

#### What Phase 6 Does
- ✅ Reads HITL decisions from HUD's Supabase
- ✅ Calculates human approval ratios
- ✅ Adjusts pass/fail thresholds to match human judgment

#### What Phase 6 Does NOT Do (Future - Phase 6.5)
- ❌ Feed rejection reasons back to Temp-gen
- ❌ Adjust generation prompts/parameters
- ❌ Per-model weight adjustment

---

## Phase 5 Completion Summary (2026-01-18)

### What Was Done

#### Phase 4: Fix CLIP Index ✅
- **Problem**: `jennikayne-brand-dna-clip768` was empty (0 vectors)
- **Root Cause**: No reference images existed at `BDE/data/reference_images/jenni_kayne/`
- **Solution**: Created directory with 107 images, ran `ingest_clip768.py`
- **Result**: 106 vectors now in CLIP index, visual similarity working

#### Phase 5: ID Alignment ✅
- **Problem**: Per-asset fusion failed due to ID format mismatch
  - CLIP: `jenni_kayne_lifestyle_blend_estate_v1_wide_standing_png`
  - E5: `jenni_kayne_lifestyle_0000` (sequential)
  - Cohere: `ref_lifestyle_016` (sequential)
- **Solution**:
  - Cleared E5 and Cohere namespaces
  - Updated `ingest_e5_cohere.py` to use separate indices (E5: 1024D, Cohere: 1536D)
  - Fixed Cohere model ID to inference profile: `us.cohere.embed-v4:0`
  - Re-ingested with filename-based IDs
- **Result**: All indices aligned, triple fusion achieves AUTO_PASS

### Test Results (Post Phase 5)
```
CLIP (Visual):    Score 0.9962 ✅ Working (self-match)
E5 (Semantic):    Score 0.8424 ✅ Working
Cohere (Multi):   Score 0.5368 ✅ Working
Gate Decision:    AUTO_PASS ✅
```

### Session Commits (2026-01-18)

| Repo | Branch | Commit | Description |
|------|--------|--------|-------------|
| BDE | `antigravity` | `04b9985` | Phase 5: Fix ID alignment across indices |
| BDE | `antigravity` | `d423ca5` | docs: Update CONTEXT_HANDOFF.md |
| Brand_linter | `phase-3` | `f0bab1b` | Phase 5: Update multimodal retriever |
| HUD | `tim-dev` | (pending) | Update HANDOFF.md with Phase 4+5 |

---

## Phase 3 Summary (Previous Session)

### What Was Done
1. **Fixed Cohere v4 Model IDs** across all files
   - Changed `cohere.embed-english-v3` → `cohere.embed-v4:0`
   - Files: `BDE/tools/index_cohere_captions.py`, `ingest_e5_cohere.py`, `ingest_documents.py`

2. **Created `cohere_multicrop.py`** in Brand_linter
   - `bedrock_embed_interleaved_query()` - 1536D embeddings via AWS Bedrock
   - `query_cohere_index_maxpool()` - Multi-crop max-pooling strategy

3. **Repo Cleanup** (Brand_linter)
   - Archived legacy docs to `archive/legacy_docs/`
   - Archived experiments to `archive/experiments/`
   - Moved Veo tools to `veo_tooling_export/`

---

## Component CHANGELOGs

| Component | Changelog Location |
|-----------|-------------------|
| Brand_linter | `~/Desktop/Brand_linter/local_quick_setup/CHANGELOG.md` |
| BDE | `~/BDE/CHANGELOG.md` |
| HUD | (this file) |

---

## Brand_linter Repo Structure (Post-Cleanup)

```
~/Desktop/Brand_linter/local_quick_setup/
├── tools/
│   ├── cohere_multicrop.py      # ✅ Phase 3 - Cohere v4 multimodal
│   ├── multimodal_retriever.py  # ✅ Triple fusion (CLIP + E5 + Cohere)
│   ├── clip_embedder.py         # CLIP embedding generation
│   └── ...
├── data/
│   ├── brand_profiles.json      # ✅ Updated with Cohere stats
│   └── test_images/             # Test images for retrieval
├── archive/
│   ├── legacy_docs/             # Old Phase 3 planning docs
│   └── experiments/             # Test scripts, notebooks
├── veo_tooling_export/          # Veo video generation tools
├── PROJECT_STATUS.md            # ✅ Phase 3 complete
└── CHANGELOG.md                 # ✅ Change history
```

---

## HUD Current State

### Completed
- **Phase 1:** Core pipeline, Supabase integration, worker polling, real-time logs
- **Phase 2:** Campaign creator, RAG generation, HITL review, artifact gallery

### Database
- Migration `002_campaigns_and_config.sql` has been run in Supabase
- Tables: `clients`, `runs`, `run_logs`, `artifacts`, `campaigns`, `hitl_decisions`

### Working Components
| Component | Location | Status |
|-----------|----------|--------|
| HUD Frontend | `src/App.tsx` | Working at localhost:5173 |
| Python Worker | `worker/worker.py` | Polls Supabase, executes runs |
| Campaign Modal | `src/components/CampaignModal.tsx` | Creates campaigns with deliverables |
| HITL Review | `src/components/HITLReviewPanel.tsx` | Score display, approve/reject |
| Artifact Gallery | `src/components/ArtifactGallery.tsx` | Grid/list view with filters |
| RAG Generator | `worker/executors/rag_generator.py` | Brand DNA context injection |

### To Run
```bash
# Terminal 1 - Worker
cd ~/Hud/worker && python worker.py

# Terminal 2 - Frontend
cd ~/Hud && npm run dev
```

---

## Next Steps (Phase 6.5+)

### Generation Feedback Loop (Phase 6.5)
1. **Add structured rejection categories** to HITLReviewPanel (too_dark, wrong_colors, off_brand, etc.)
2. **Feed rejection patterns back to Temp-gen** for prompt refinement
3. **Per-model weight adjustment** based on disagreement patterns

### Brand_linter / BDE
1. **Calibrate z-score thresholds** - Current thresholds may need tuning
2. ~~Wire up HITL/RL loop~~ ✅ **DONE (Phase 6)**
3. **Production deployment** - Move from dev to production

### HUD Phase 3+ Features (Not Yet Implemented)
- Platform-specific export (Instagram, Amazon, etc.)
- Overnight batch scheduling
- ~~RL threshold optimization from HITL feedback~~ ✅ **DONE (Phase 6)**
- Multi-user auth / role-based access
- Docker deployment
- File upload UI for brand assets

### Important Notes
- Use `--top-k 20` for multimodal retriever (better cross-modality overlap)
- Cohere model ID: `us.cohere.embed-v4:0` (inference profile required)
- E5 and Cohere require separate indices (different dimensions)

---

## Key Files Modified in Phase 2

```
src/api.ts                    - Campaign CRUD, HITL decisions, artifact queries
src/App.tsx                   - Integrated modals and handlers
src/components/*.tsx          - CampaignModal, HITLReviewPanel, ArtifactGallery, PromptInput
worker/worker.py              - Added campaign mode
worker/executors/rag_generator.py - New RAG executor
supabase/migrations/002_*.sql - Phase 2 schema
```

---

## Per-Client Config

| Client | Pinecone Namespace | Storage |
|--------|-------------------|---------|
| Jenni Kayne | `jenni_kayne` | Cloudinary |
| Lilydale | `lilydale` | Cloudinary |
| Cylndr | `cylndr` | S3 |

---

## Pinecone Index Reference

### Jenni Kayne (Phase 5 Complete)
| Index | Dimension | Vectors | Namespace | ID Format | Status |
|-------|-----------|---------|-----------|-----------|--------|
| `jennikayne-brand-dna-clip768` | 768D | 106 | `__default__` | filename-based | ✅ Working |
| `jennikayne-brand-dna-e5` | 1024D | 107 | `e5` | filename-based | ✅ Working |
| `jennikayne-brand-dna-cohere` | 1536D | 107 | `cohere` | filename-based | ✅ Working |

**ID Format Example**: `jenni_kayne_lifestyle_blend_estate_v1_wide_standing_png`

### Cylndr
| Index | Dimension | Vectors | Status |
|-------|-----------|---------|--------|
| `cylndr-brand-dna-clip768` | 768D | 511 | ✅ Working |
| `cylndr-e5-inference` | 1024D | 50 | ✅ Working |

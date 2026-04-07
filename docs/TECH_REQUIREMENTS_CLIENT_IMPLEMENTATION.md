# BrandStudios.AI — Technical Requirements for Client Implementation

HITL Decision Document | Based on canonical architecture spec + integration audit (2026-03-31)

---

## How to Read This Document

Each section maps to a phase of the BrandStudios.AI architecture. For each phase:
- **What it does** — plain English
- **What's built** — infrastructure and code that exists today
- **What's missing** — gaps that must be closed before client work
- **HITL gates** — human decision points before proceeding
- **Per-client work** — what has to happen for each new brand

---

## Pre-Flight: Platform Requirements

Before onboarding any client, these platform services must be operational.

### Services

| Service | Status | Account | Purpose |
|---------|--------|---------|---------|
| Supabase | ACTIVE | Project `tfbfzepaccvklpabllao` | Central database, Realtime, RLS |
| Pinecone | ACTIVE | Shared account | Vector storage for brand memory |
| Google GenAI | ACTIVE | Gemini API key | Image generation (Gemini 3 Pro) |
| Google Vertex AI | ACTIVE | Vertex project | Video generation (Veo 3.1) |
| AWS Bedrock | ACTIVE | AWS account | Cohere v4 embeddings (1536D) |
| Replicate | ACTIVE (blocker) | API token | CLIP embeddings (768D) — Python 3.14 broken |
| OpenAI | ACTIVE | API key | GPT captioning for E5/Cohere ingestion |
| Cloudinary / S3 | ACTIVE | Per `storage_config` | Asset storage and delivery |

### Known Blockers

| Blocker | Impact | Resolution |
|---------|--------|------------|
| Replicate CLIP broken on Python 3.14 | BDE cannot run on latest Python | Migrate to Gemini Embedding 2 |
| ~~os-api writes SQLite, not Supabase~~ | ~~HUD frontend and backend see different data~~ | **RESOLVED** — db.ts rewritten to Supabase (`b4d4fac`, 2026-04-07) |
| BDE Cohere dimension mismatch | Dormant — BDE is sidelined (runner calls Brand_linter) | Fix `feature_extractor.py` output_dimension → 1536 when BDE activated |

### HITL Gate: Platform Readiness

- [ ] All API keys verified and funded
- [ ] Supabase project accessible (Management API + REST API)
- [ ] Pinecone account has capacity for new indexes
- [x] os-api → Supabase bridge built (`b4d4fac`, 2026-04-07)
- [ ] Replicate/CLIP blocker resolved OR Gemini Embedding 2 migration complete

---

## Phase 1: Brand Onboarding & Intake

**What it does**: Collect and organize the client's brand assets — historical campaigns, style guides, photography, color palettes, typography, strategic documents, compliance rules.

### What's Built

| Component | Status | Notes |
|-----------|--------|-------|
| `clients` table in Supabase | Ready | `id`, `name`, `brand_slug`, `pinecone_namespace`, `storage_config` |
| Brand profile JSON | Ready | Per-brand config with thresholds, weights, allowed colors, index names |
| `brand_dna_indexer.py` (Brand_linter) | Ready | CLI: `--brand <slug> --images <dir>` → Pinecone CLIP index |
| `ingest_e5_cohere.py` (BDE) | Ready | CLI: ingests images via GPT captioning → E5 + Cohere indexes |
| `ingest_documents.py` (BDE) | Ready | CLI: ingests PDFs/docs → E5 semantic index |
| `ingest_clip768.py` (BDE) | Ready | CLI: batch CLIP ingestion to Pinecone |

### What's Missing

| Gap | Effort | Priority |
|-----|--------|----------|
| No onboarding UI — all CLI-driven | Large | Medium (CLI works for internal use) |
| No provenance tracking on ingested assets | Medium | High for client trust |
| No validation step before baseline formation | Medium | High |
| No structured intake form or checklist | Small | High |

### Per-Client Work

1. **Create client record in Supabase**
   ```
   INSERT INTO clients (id, name, brand_slug, pinecone_namespace, storage_config)
   ```

2. **Create brand profile JSON** in `Brand_linter/data/brand_profiles/<slug>.json` and `BDE/data/brand_profiles/<slug>.json`
   - Visual thresholds (CLIP pass/fail/review bands)
   - Semantic thresholds (E5, Cohere)
   - Allowed color palettes
   - Disallowed patterns
   - Pinecone index names

3. **Provision Pinecone indexes** (6 per brand minimum):
   ```
   <slug>-brand-dna-clip768    (768D, cosine)
   <slug>-brand-dna-e5         (1024D, cosine)
   <slug>-brand-dna-cohere     (1536D, cosine)
   <slug>-core-clip768         (768D, cosine)
   <slug>-core-e5-1024         (1024D, cosine)
   <slug>-core-cohere1536      (1536D, cosine)
   ```
   Optional campaign indexes (created when first campaign runs):
   ```
   <slug>-campaign-clip768     (768D, cosine)
   <slug>-campaign-e5-1024     (1024D, cosine)
   <slug>-campaign-cohere1536  (1536D, cosine)
   ```

4. **Collect and organize brand assets**
   - Reference images (lifestyle, product, locations)
   - Brand PDFs (style guides, strategy docs)
   - Historical campaign materials
   - Compliance constraints

5. **Run ingestion pipeline**
   ```bash
   # CLIP embeddings (visual)
   python tools/brand_dna_indexer.py --brand <slug> --images <dir>

   # E5 + Cohere embeddings (semantic — requires GPT captioning)
   python tools/ingest_e5_cohere.py --brand <slug> --images <dir>

   # Document embeddings (brand guides, PDFs)
   python tools/ingest_documents.py --brand <slug> --docs <dir>
   ```

6. **Verify ingestion**
   - Check vector counts in all 6 indexes
   - Run test queries against each index
   - Validate similarity scores against known reference images

### HITL Gate: Intake Complete

- [ ] Client record exists in Supabase with correct `brand_slug` and `pinecone_namespace`
- [ ] Brand profile JSON created with appropriate thresholds
- [ ] All 6 Pinecone indexes created and populated
- [ ] Test queries return sensible similarity scores
- [ ] Client has reviewed and approved the reference asset set
- [ ] Storage config (S3/Cloudinary) provisioned for this brand

---

## Phase 2: Memory Formation & Baselines

**What it does**: Establish the protected brand foundation — the "truth" layer that all future generation and drift checking measures against. Set baseline similarity scores from the reference corpus.

### What's Built

| Component | Status | Notes |
|-----------|--------|-------|
| `brand_baselines` table | Ready | Per-client baseline Z-scores for CLIP, E5, Cohere, fused |
| Pinecone `core` tier indexes | Ready | Separate from `brand-dna` and `campaign` tiers |
| Triple fusion retriever (BDE) | Ready | Z-score normalization across 3 models |
| RLS on all tables | Ready | Currently permissive — needs tightening per client |

### What's Missing

| Gap | Effort | Priority |
|-----|--------|----------|
| No baseline calculation logic connected to `brand_baselines` table | Medium | High |
| No versioning on baselines | Small | Medium |
| RLS policies are fully permissive (public access) | Medium | High before multi-client |
| No approval flow for baseline lock-in | Medium | Medium |

### Per-Client Work

1. **Calculate baseline scores** — run the triple fusion retriever against the full reference corpus to establish mean similarity scores and standard deviations per model
2. **Write baseline record**
   ```
   INSERT INTO brand_baselines (client_id, clip_baseline_z, e5_baseline_z,
     cohere_baseline_z, fused_baseline_z, clip_baseline_raw, e5_baseline_raw,
     cohere_baseline_raw, clip_stddev, e5_stddev, cohere_stddev, sample_count)
   ```
3. **Configure RLS** — when multi-client, scope read/write by client_id
4. **Lock baseline version** — set `is_active = true`, `version = 1`

### HITL Gate: Baseline Approved

- [ ] Baseline Z-scores calculated and reviewed
- [ ] Scores represent expected brand aesthetic (not skewed by outlier assets)
- [ ] Pass/fail/review bands make sense for this brand's tolerance
- [ ] Baseline record written to Supabase
- [ ] Decision: any assets to exclude from baseline? Rerun if needed

---

## Phase 3: Project / Campaign Activation

**What it does**: Create a scoped campaign with specific goals, deliverables, platform targets, and reference materials. This is where the client brief becomes a structured execution plan.

### What's Built

| Component | Status | Notes |
|-----------|--------|-------|
| `campaigns` table | Ready | name, prompt, deliverables (JSONB), platforms, mode, max_retries, reference_images, guardrails |
| `campaign_deliverables` table | Ready | Per-deliverable tracking with prompt evolution, rejection reasons, retry count |
| `campaign_memory` table | Ready | Per-campaign prompt evolution history (prompt_before, prompt_after, score_before) |
| 3 real campaigns in DB | Exists | Cylndr merch + JK spring collection |

### What's Missing

| Gap | Effort | Priority |
|-----|--------|----------|
| No campaign creation UI | Large | Medium (can be created via API/SQL) |
| No reference image upload flow | Medium | High |
| No campaign → run connection in runner | Medium | High |
| `runs` table has `campaign_id` column but runner doesn't use it | Small | High |

### Per-Client Work (per campaign)

1. **Create campaign record**
   ```
   INSERT INTO campaigns (client_id, name, prompt, deliverables, platforms, mode, max_retries, guardrails)
   ```
   Deliverables format: `{"heroImages": 1, "lifestyleImages": 3, "productShots": 1, "videos": 0}`

2. **Create deliverable records** — one per asset to generate
   ```
   INSERT INTO campaign_deliverables (campaign_id, description, ai_model, current_prompt, original_prompt)
   ```

3. **Attach reference images** (if any) — URLs in `reference_images` array

4. **Set guardrails** (if any) — JSONB with constraints

### HITL Gate: Campaign Brief Approved

- [ ] Campaign prompt reviewed by brand team
- [ ] Deliverable count and types confirmed
- [ ] Target platforms specified
- [ ] Reference images attached (if applicable)
- [ ] Guardrails set (color restrictions, composition rules, etc.)
- [ ] Max retries configured (default: 3)

---

## Phase 4: Runtime Environment Assembly

**What it does**: Before generation runs, assemble the correct context — pull the right brand memory from Pinecone, load the campaign brief, set up the execution environment.

### What's Built

| Component | Status | Notes |
|-----------|--------|-------|
| `runs` table | Ready | Tracks execution with stages JSONB, campaign_id, prompt |
| os-api runner.ts | Ready | Sequential stage execution with demo fallback |
| Brand profile loading | Ready | JSON configs per brand |

### What's Missing

| Gap | Effort | Priority |
|-----|--------|----------|
| ~~Runner doesn't pull from Pinecone at runtime~~ | ~~Large~~ | **RESOLVED** (`17dd313`, 2026-04-06) |
| ~~Runner doesn't load campaign brief from Supabase~~ | ~~Medium~~ | **RESOLVED** (`e12f5f5`, 2026-04-04) |
| ~~No runtime retrieval package assembly~~ | ~~Large~~ | **RESOLVED** (`17dd313`, 2026-04-06) |
| ~~Runner writes to SQLite, not Supabase~~ | ~~Medium~~ | **RESOLVED** (`b4d4fac`, 2026-04-07) |

### Per-Client Work

None beyond what's configured in Phases 1-3. Runtime environment is assembled automatically from client config + campaign brief.

### HITL Gate: None (automated)

Runtime assembly should be automatic. Human intervention only if the environment fails to assemble.

---

## Phase 5: Generation

**What it does**: Generate images and video using the campaign brief and brand context.

### What's Built

| Component | Status | Notes |
|-----------|--------|-------|
| Temp-gen nano CLI | Ready | `python main.py nano generate --prompt "..." --output file.png` |
| Temp-gen veo CLI | Ready | `python main.py veo generate --prompt "..." --output file.mp4` |
| Gemini 3 Pro Image model | Ready | Primary image generation |
| Veo 3.1 model | Ready | Video generation |
| Cost tracking | Ready | Per-model cost calculation in Temp-gen |
| Batch generation | Ready | JSON job files with budget caps |
| `artifacts` table | Ready | Tracks generated assets with grade, thumbnail, deliverable_id, prompt_used, retry_number |

### What's Missing

| Gap | Effort | Priority |
|-----|--------|----------|
| ~~Prompts are static~~ | ~~Medium~~ | **RESOLVED** — campaign prompts propagated (`e12f5f5`), prompt evolution system built (`b7118ce`) |
| ~~No prompt evolution from rejection feedback~~ | ~~Medium~~ | **RESOLVED** (`b7118ce`, 2026-04-07) |
| No connection between `campaign_deliverables.current_prompt` and Temp-gen | Medium | High |
| Generated artifacts not written to `artifacts` table in Supabase | Medium | High |

### Per-Client Work

None beyond campaign configuration. Generation uses the same models/tools for all clients.

### HITL Gate: None at generation time

Generation runs automatically. HITL happens at the drift/review stage (Phase 6).

---

## Phase 6: Governance, Drift Check, Human Review

**What it does**: Check generated work against brand baselines, flag drift, route to human review.

### What's Built

| Component | Status | Notes |
|-----------|--------|-------|
| `image_analyzer.py` (Brand_linter) | Ready | Pixel-level: saturation, whitespace, clutter, palette |
| `triple_fusion_retriever.py` (BDE) | Ready | CLIP + E5 + Cohere similarity scoring |
| `hitl_decisions` table | Ready | artifact_id, run_id, decision, notes, grade_scores, rejection_categories |
| `rejection_categories` table | Ready | 10 categories with negative_prompt and positive_guidance |
| `drift_metrics` table | Ready | Per-model Z-scores, drift deltas, alert triggers |
| `drift_alerts` table | Ready | Severity, acknowledgment tracking, resolution notes |
| `brand_baselines` table | Ready | Reference scores for drift calculation |

### What's Missing

| Gap | Effort | Priority |
|-----|--------|----------|
| ~~Runner doesn't pass `--profile` to drift check~~ | ~~10 min~~ | **RESOLVED** (`cd65bbd`, 2026-04-03) |
| ~~Drift check only runs pixel analysis, not RAG similarity~~ | ~~Medium~~ | **RESOLVED** — `--profile` enables RAG |
| ~~No connection between drift results and `drift_metrics` table~~ | ~~Medium~~ | **RESOLVED** (`e12f5f5`, 2026-04-04) |
| No alert generation logic for `drift_alerts` | Medium | High |
| ~~HITL decisions written to SQLite, not `hitl_decisions` table~~ | ~~Medium~~ | **RESOLVED** (`cd65bbd`, 2026-04-03) |
| No review UI in HUD for HITL decisions | Large | High |

### Per-Client Work

1. **Review generated assets** — human evaluates each against brand standards
2. **Record HITL decisions** — approve, reject with categories + notes
3. **Monitor drift metrics** — track brand alignment over time

### HITL Gate: Asset Review

This IS the primary HITL gate. For each generated asset:

- [ ] Asset reviewed against brand baseline
- [ ] Decision recorded: `approved`, `rejected`, or `needs_revision`
- [ ] If rejected: rejection categories selected from taxonomy
  - `too_dark`, `too_bright`, `wrong_colors`, `off_brand`, `wrong_composition`
  - `cluttered`, `wrong_model`, `wrong_outfit`, `quality_issue`, `other`
- [ ] Custom rejection notes added (if applicable)
- [ ] Grade scores recorded (JSONB: `{clip_z, e5_z, cohere_z, fused_z}`)

**On rejection**: `campaign_deliverables.current_prompt` should be updated with negative prompts from the rejection category, and the deliverable retried (up to `max_retries`).

---

## Phase 7: Asset Preparation & Delivery

**What it does**: Transform approved assets into platform-ready deliverables.

### What's Built

| Component | Status | Notes |
|-----------|--------|-------|
| `campaign_deliverables` table | Ready | Tracks per-deliverable status through lifecycle |
| S3 storage integration (Temp-gen) | Ready | Upload on generation |
| Cloudinary integration | Ready | Referenced in client `storage_config` |

### What's Missing

| Gap | Effort | Priority |
|-----|--------|----------|
| No platform-specific formatting (aspect ratios, compression) | Large | Medium |
| No export packaging beyond placeholder | Large | Medium |
| No delivery manifest or tracking | Medium | Medium |

### Per-Client Work

1. Define target platforms per campaign (stored in `campaigns.platforms`)
2. Configure platform-specific formatting rules
3. Set up delivery destination (S3 bucket, CDN, etc.)

### HITL Gate: Delivery Approval

- [ ] Final assets meet platform specs (dimensions, format, file size)
- [ ] Client has reviewed final package
- [ ] Delivery destination configured and tested

---

## Phase 8: Insight Loop

**What it does**: Track how assets perform after delivery — engagement, usage, brand alignment trends.

### What's Built

| Component | Status | Notes |
|-----------|--------|-------|
| `drift_metrics` table | Ready | Schema supports time-series drift tracking |
| `drift_alerts` table | Ready | Schema supports alert lifecycle |

### What's Missing

| Gap | Effort | Priority |
|-----|--------|----------|
| Entire phase is unbuilt (no collection, processing, or analysis logic) | Very Large | Low (post-MVP) |
| No channel telemetry integration | Very Large | Low |
| No provenance/authenticity tracking | Large | Medium |

### Per-Client Work

Post-MVP. When built, requires integration with client's analytics platforms.

### HITL Gate: None currently

---

## Phase 9: Governed Promotion

**What it does**: Selectively promote successful campaign learnings back into brand memory.

### What's Built

| Component | Status | Notes |
|-----------|--------|-------|
| `rl_trainer.py` (Brand_linter) | Ready | Adjusts thresholds based on HITL approval ratios |
| `brand_baselines` versioning | Ready | `version` column, `is_active` flag |
| Campaign → Core promotion path | Ready | Separate Pinecone index tiers (campaign → core → brand-dna) |

### What's Missing

| Gap | Effort | Priority |
|-----|--------|----------|
| ~~RL trainer reads local SQLite, not Supabase `hitl_decisions`~~ | ~~Medium~~ | **RESOLVED** (BDE `260037e`, 2026-04-07) |
| No promotion UI or approval flow | Large | Medium |
| No logic to copy vectors between Pinecone index tiers | Medium | Medium |

### Per-Client Work

1. After sufficient HITL decisions, run RL trainer to calibrate thresholds
2. Review proposed threshold changes before applying
3. Decide which campaign assets merit promotion to core/brand-dna tier

### HITL Gate: Promotion Approval

- [ ] RL trainer output reviewed (proposed threshold adjustments)
- [ ] Approval ratio data makes sense (not biased by small sample)
- [ ] Decision: update baseline version or keep current
- [ ] Decision: promote any campaign vectors to core/brand-dna indexes

---

## Summary: Client Implementation Checklist

### One-Time Platform Setup (do once)

- [ ] Resolve Replicate/CLIP blocker (Gemini Embedding 2 migration)
- [ ] Fix BDE Cohere dimension mismatch (1024 → 1536) — dormant, fix when BDE activated
- [x] Bridge os-api to write Supabase instead of SQLite (`b4d4fac`, 2026-04-07)
- [ ] Build HITL review UI in HUD
- [x] Connect runner to use campaign prompts from Supabase (`e12f5f5`, 2026-04-04)
- [x] Add `--profile` flag to drift stage in runner (`cd65bbd`, 2026-04-03)

### Per-Client Onboarding (~1-2 days with HITL gates)

| Step | Owner | Effort | HITL? |
|------|-------|--------|-------|
| 1. Collect brand assets | Client + BS team | Varies | Yes — asset set approval |
| 2. Create client in Supabase | BS team | 15 min | No |
| 3. Create brand profile JSON | BS team | 1 hr | Yes — threshold review |
| 4. Provision Pinecone indexes (6-9) | BS team | 30 min | No |
| 5. Run ingestion (CLIP + E5 + Cohere + docs) | BS team | 2-4 hrs | No |
| 6. Verify ingestion + test queries | BS team | 1 hr | Yes — quality check |
| 7. Calculate and set baselines | BS team | 1 hr | Yes — baseline approval |
| 8. Configure storage (S3/Cloudinary) | BS team | 30 min | No |

### Per-Campaign Execution (~hours to days depending on volume)

| Step | Owner | Effort | HITL? |
|------|-------|--------|-------|
| 1. Create campaign brief | Client + BS team | 30 min | Yes — brief approval |
| 2. Create deliverable records | BS team | 15 min | No |
| 3. Run generation | Automated | Minutes | No |
| 4. Drift check | Automated | Minutes | No |
| 5. Human review of generated assets | Client + BS team | Varies | **Yes — primary HITL** |
| 6. Retry rejected assets (up to max_retries) | Automated | Minutes | No |
| 7. Final approval | Client | Varies | Yes |
| 8. Asset preparation + delivery | BS team | 1 hr | Yes — delivery approval |

### Post-Campaign (optional)

| Step | Owner | Effort | HITL? |
|------|-------|--------|-------|
| 1. Run RL trainer on HITL decisions | BS team | 1 hr | Yes — threshold review |
| 2. Promote vectors to core indexes | BS team | 1 hr | Yes — promotion approval |
| 3. Update baseline version | BS team | 30 min | Yes — baseline approval |

---

## Infrastructure Cost Estimates (Per Client)

| Service | Per Client | Notes |
|---------|-----------|-------|
| Pinecone | 6-9 indexes | Free tier may cover small brands; paid for large corpora |
| Supabase | Shared project | Rows scale with campaigns and runs |
| Gemini API | Per-image generation | ~$0.04/image (Gemini 3 Pro) |
| Veo API | Per-video generation | ~$0.50/7s clip (Veo 3.1) |
| AWS Bedrock (Cohere) | Per-embedding | ~$0.001/embedding |
| Replicate (CLIP) | Per-embedding | ~$0.002/embedding |
| OpenAI (captioning) | Per-caption | ~$0.01/caption |
| S3/Cloudinary | Per-asset stored | Varies by volume |

---

## Database Schema Reference

### Core Tables (per-client)

```
clients              → Brand identity + config
brand_baselines      → Versioned similarity baselines per model
```

### Per-Campaign Tables

```
campaigns            → Brief, deliverables spec, platforms, guardrails
campaign_deliverables → Per-asset tracking with prompt evolution
campaign_memory      → Prompt mutation history per retry
runs                 → Execution tracking with stage JSONB
run_logs             → Timestamped execution logs
artifacts            → Generated assets with grade, prompt_used, retry_number
```

### Governance Tables

```
hitl_decisions       → Human review decisions with grade_scores
rejection_categories → Taxonomy with negative_prompt / positive_guidance
drift_metrics        → Per-model Z-scores and drift deltas over time
drift_alerts         → Drift severity tracking with acknowledgment lifecycle
```

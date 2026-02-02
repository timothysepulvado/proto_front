# Test Log - BrandStudios OS

Tracking test results across phases and components.

---

## Test Environment

| Component | Version/Branch | Location |
|-----------|----------------|----------|
| HUD | `tim-dev` | `~/Hud` |
| Brand_linter | `phase-3` | `~/Desktop/Brand_linter/local_quick_setup` |
| BDE | `antigravity` | `~/BDE` |
| Python | 3.11+ | System |
| Node | 18+ | System |

---

## Phase 7.2.1 Integration Testing (2026-02-01)

### Summary

| Test Category | Pass | Fail | Total |
|---------------|------|------|-------|
| Import Tests | 3 | 0 | 3 |
| E5 Ingestion | 1 | 0 | 1 |
| Cohere Ingestion | 0 | 1 | 1 |
| Triple Fusion | 1 | 0 | 1 |

### Detailed Results

#### 1. Import Tests

```bash
# Command
cd ~/Hud/worker && python -c "from workers.scoring_worker import ScoringWorker; print('OK')"
```

| Module | Status | Notes |
|--------|--------|-------|
| `workers.scoring_worker` | PASS | Imports cleanly |
| `workers.dna_updater` | PASS | Imports cleanly |
| `workers.orchestrator` | PASS | Imports cleanly |

#### 2. E5 Ingestion Test

```bash
# Command
cd ~/Desktop/Brand_linter/local_quick_setup && \
python tools/index_e5_embeddings.py \
  ~/BDE/data/reference_images/jenni_kayne/lifestyle/blend_estate_v1_wide_standing.png \
  --brand jenni_kayne \
  --caption "woman standing in wide shot estate outdoor setting"
```

| Test | Status | Output |
|------|--------|--------|
| Single-image ingestion | PASS | Vector upserted to `jennikayne-brand-dna-e5` |

#### 3. Cohere Ingestion Test

```bash
# Command
cd ~/Desktop/Brand_linter/local_quick_setup && \
python tools/index_cohere_embeddings.py \
  ~/BDE/data/reference_images/jenni_kayne/lifestyle/blend_estate_v1_wide_standing.png \
  --brand jenni_kayne
```

| Test | Status | Error |
|------|--------|-------|
| Single-image ingestion | FAIL | `ValidationException: Could not resolve model identifier` |

**Root Cause**: AWS Bedrock requires inference profile ARN, not base model ID.
- Wrong: `cohere.embed-v4:0`
- Correct: `us.cohere.embed-v4:0`

**Fix Location**: `Brand_linter/tools/index_cohere_embeddings.py`

#### 4. Triple Fusion Test

```bash
# Command
cd ~/Desktop/Brand_linter/local_quick_setup && \
python tools/multimodal_retriever.py \
  ~/BDE/data/reference_images/jenni_kayne/lifestyle/blend_estate_v1_wide_standing.png \
  "woman standing in wide shot estate outdoor setting fashion" \
  --brand jenni_kayne \
  --top-k 20 \
  --json
```

| Test | Status | Result |
|------|--------|--------|
| Fusion query | PASS | Gate: AUTO_PASS |

---

## Test Templates

### Import Test Template

```bash
cd ~/Hud/worker && python -c "from <module> import <class>; print('OK')"
```

### Ingestion Test Template

```bash
cd ~/Desktop/Brand_linter/local_quick_setup && \
python tools/<ingest_script>.py <image_path> --brand <brand_id> [options]
```

### Fusion Query Test Template

```bash
cd ~/Desktop/Brand_linter/local_quick_setup && \
python tools/multimodal_retriever.py <image_path> "<text_query>" \
  --brand <brand_id> --top-k 20 --json
```

---

## Regression Test Checklist

Run before each release:

### HUD Worker Tests
- [ ] `from workers.scoring_worker import ScoringWorker`
- [ ] `from workers.dna_updater import DNAUpdater`
- [ ] `from workers.orchestrator import Orchestrator`
- [ ] `from workers.generation_worker import GenerationWorker`
- [ ] `from workers.prompt_modifier import PromptModifier`

### Brand_linter Tests
- [ ] E5 single-image ingestion
- [ ] Cohere single-image ingestion (after ARN fix)
- [ ] CLIP single-image ingestion
- [ ] Triple fusion query (--top-k 20)
- [ ] Per-brand profile loading

### BDE Tests
- [ ] `python tools/triple_fusion_retriever.py <image> --brand jenni_kayne`
- [ ] `python tools/rl_trainer.py --brand jenni_kayne --dry-run`

---

## Historical Results

| Phase | Date | Pass Rate | Notes |
|-------|------|-----------|-------|
| 7.2.1 | 2026-02-01 | 5/6 (83%) | Cohere ARN issue known |
| 7.2 | 2026-01-31 | N/A | No formal test log |
| 7.1 | 2026-01-30 | N/A | No formal test log |

---

## Known Issues

| Issue | Component | Status | Workaround |
|-------|-----------|--------|------------|
| Cohere model ID | Brand_linter | Open | Use `us.cohere.embed-v4:0` |

---

**Last Updated**: 2026-02-01

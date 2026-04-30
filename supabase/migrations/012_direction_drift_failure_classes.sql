-- 012_direction_drift_failure_classes.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Direction-drift failure classes — productizes the 2026-04-30 audit findings
-- into four new image-class rows on `known_limitations`. Closes the loop on
-- two convergent issues:
--
--   1. Tim's 2026-04-30 observation that some Drift MV stills regressed back
--      to mech-heavy after the 2026-04-25 aftermath/realistic pivot. The
--      brand-engine `/grade_image_v2` critic and the os-api Claude Opus 4.7
--      orchestrator both missed this — neither has a first-class concept of
--      "campaign direction" with prohibited approaches.
--
--   2. Phase B+ smoke #4 (handoff 2026-04-29-PM-phase-b-plus-1-smoke-4-results.md)
--      finding that the catalog-aware critic was TOO GENEROUS — score drift
--      went UP after migration 009 landed (+0.17-0.98 vs +0.07-0.67) because
--      the existing `mitigation` text describes FIXES, not DEDUCTIONS. The
--      critic interprets the catalog as a problem-solving guide rather than
--      a scoring rubric.
--
-- This migration encodes deduction multipliers in the `mitigation` text using
-- a parseable `<<DEDUCT: criterion=-N.N, ...>>` marker that the Phase 4
-- critic rubric (`brand-engine/brand_engine/core/image_grader.py
-- ::_build_critic_system_prompt` + `::_compute_verdict_for_stills`) will
-- parse and enforce server-side. This is intentionally additive — no schema
-- change to `known_limitations` (the typed `deductions` JSONB column is
-- Phase H scope).
--
-- Source documents:
--   ~/Temp-gen/productions/drift-mv/jackie_direction_audit_2026-04-30.md
--     (per-shot 30×4 audit table; 6 drifted, 11 aligned, 13 borderline)
--   ~/.claude/plans/lets-pick-back-up-parallel-crown.md
--   ~/proto_front/.claude/handoffs/brandy/2026-04-29-PM-phase-b-plus-1-smoke-4-results.md
--   ~/agent-vault/adr/004-stills-critic-in-loop.md (ACCEPTED)
--   ~/agent-vault/adr/005-campaign-branching-versioning.md (PROPOSED)
--
-- Adds 1 new category to the catalog (no CHECK constraint on `category`,
-- so this is additive only): `narrative` (campaign-level direction axiom).
-- Existing categories: 'atmospheric', 'temporal', 'character', 'lighting',
-- 'zoom', 'composition', 'aesthetic', 'content'.
--
-- Idempotent via existing UNIQUE(failure_mode) + ON CONFLICT DO UPDATE pattern
-- mirroring 007 + 009.
--
-- Model: gemini-3-pro-image-preview (Nano Banana Pro). All 4 classes are
-- image-class only; video critic uses migration 007's seed.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO known_limitations (model, category, failure_mode, description, mitigation, severity, detected_in_production_id)
VALUES
  (
    'gemini-3-pro-image-preview',
    'aesthetic',
    'campaign_direction_reversion_mech_heavy',
    'Mech-heavy composition reintroduced after the campaign pivoted to aftermath/realistic direction. Symptoms: multiple visible mechs as primary visual subject, mech-as-hero framing, parade-formation arrangement, action-figure diorama composition, render polish overriding documentary mantra. The aftermath direction explicitly subordinates mechs to landscape/architecture/wreckage; mech-hero framing is the rejected pre-pivot aesthetic. First observed Drift MV 2026-04-30 audit on shots 4, 7, 16, 18, 20 (5 of 30). Distinct from `three_mech_parade_formation_staging_bias` (composition pattern within a mech-heavy frame) and `documentary_polish_drift_3d_render` (rendering-quality issue) — this class catches the higher-level direction reversion regardless of composition pattern.',
    '<<DEDUCT: narrative_alignment=-1.5, aesthetic_match=-1.0>> When detected, deduct 1.5 from narrative_alignment AND 1.0 from aesthetic_match. The aftermath direction subordinates mechs to landscape/architecture/wreckage; mech-as-hero framing is canonical-rejected per the 2026-04-25 directional pivot. Recommend L2 (approach change — re-frame to landscape-dominant, push mechs to mid/deep background, reduce mech screen real estate to <30% of frame, foreground non-mech anchors like rubble/architecture/wreckage) NOT L1 (prompt fix). Direction reversion almost never resolves at prompt level because the underlying problem is composition, not language.',
    'blocking',
    'drift-mv'
  ),
  (
    'gemini-3-pro-image-preview',
    'narrative',
    'aftermath_mantra_violation_active_action',
    'Active poses, motion, ongoing action, or mid-event framing where the aftermath mantra requires stillness, wreckage, or post-event framing. Examples: mechs mid-stride with weapons raised, fire/explosion mid-event (not aftermath), characters in active poses where deactivated/aftermath beats are specified, motion blur on subjects that should be static. Aftermath mantra: `Cinematically beautiful · Documentary dry · No effects/gloss/polish · Nothing falling out of the sky`. First observed Drift MV 2026-04-30 audit; precursor pattern in 009 catalog `narrative_beat_inversion_active_vs_deactivated` (mech-specific) — this class generalizes to humans + scenes.',
    '<<DEDUCT: narrative_alignment=-1.5>> When detected, deduct 1.5 from narrative_alignment. Replace active-pose language with positive structural aftermath language: `collapsed face-down`, `partially buried`, `severed from torso`, `optics extinguished`, `motionless for 8s`, `hands hanging at sides`, `eyes downcast`. The aftermath direction is documentary-dry — no falling debris, no in-progress destruction, no halos/auras. Recommend L1 (prompt_fix) on first detection if criterion-deficit is isolated; L2 if the entire scene composition implies action.',
    'blocking',
    'drift-mv'
  ),
  (
    'gemini-3-pro-image-preview',
    'character',
    'mech_color_identity_drift_off_manifest_spec',
    'Faction-specific mech colors collapse to generic gold-chrome or default-render colors instead of the manifest-specified hex codes. Drift MV manifest specifies #1A8C3E green-circuitry for OpenAI mech, #9B59B6 deep purple + #E67E22 burnt-orange accents for Claude mech, #2980B9 brushed-steel blue for Grok mech, and patchwork-of-corporate-detritus for Gemini. When multiple mechs share a frame the model defaults to identical gold-chrome figures (Pacific-Rim aesthetic), losing all faction identity. First observed Drift MV 2026-04-30 audit on shots 14, 16, 20. Distinct from existing 007 catalog `backlight_color_homogenization` (lighting-driven) — this class is identity-collapse driven by multi-mech composition pressure, not lighting.',
    '<<DEDUCT: mech_color_identity=-1.5>> When detected, deduct 1.5 from mech_color_identity. Use explicit hex codes inline in prompt for EACH mech (not a separate color-key sidebar): "OpenAI mech (white panels with #1A8C3E green-circuitry seams)", "Claude mech (#9B59B6 deep purple welded-steel armor with prominent #E67E22 burnt-orange accent panels)", "Grok mech (#2980B9 brushed steel blue, Cybertruck-angular bolted panels)". Pair with a color-distinction sentence ("each mech color clearly distinguishable per faction; NO uniform gold-chrome rendering"). Front/side lighting (per Rule 17) preserves color separation; backlight defeats it.',
    'warning',
    'drift-mv'
  ),
  (
    'gemini-3-pro-image-preview',
    'composition',
    'literal_split_screen_for_panning_reveal',
    'When a manifest beat specifies a sequential panning/zooming reveal (e.g., "Extreme close-up of subject, panning UP to reveal larger subject above"), the model occasionally renders a literal SPLIT-SCREEN composition with the two subjects stacked top/bottom in the same frame. This is a fundamental composition-language misinterpretation — the prompt is asking for a temporal reveal rendered as a single first-frame still, but the model packs both reveal endpoints into the still simultaneously. First observed Drift MV smoke #1 (2026-04-29) shot 22 as `new_candidate:literal_split_screen`; persistent on the same shot in 2026-04-30 audit.',
    '<<DEDUCT: composition=-2.0, narrative_alignment=-1.0>> When detected, deduct 2.0 from composition AND 1.0 from narrative_alignment. The still must show the OPENING frame of the panning sequence only — typically the close-up subject. Strip pan/zoom/reveal language from the still_prompt entirely and move it to the veo_prompt only. Replace with explicit single-subject framing: "Extreme close-up of [single subject only], shot at [framing], no other subjects in frame". Recommend L2 (approach_change — composition-level fix, not just prompt rewording).',
    'blocking',
    'drift-mv'
  )
ON CONFLICT (failure_mode) DO UPDATE SET
  description = EXCLUDED.description,
  mitigation = EXCLUDED.mitigation,
  severity = EXCLUDED.severity,
  category = EXCLUDED.category,
  updated_at = now();

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification query (manual smoke after apply):
--   SELECT failure_mode, category, severity,
--          (mitigation LIKE '%<<DEDUCT:%') AS has_deduct_marker
--   FROM known_limitations
--   WHERE model = 'gemini-3-pro-image-preview'
--   ORDER BY category, severity DESC, failure_mode;
-- Expected: 12 rows total (8 from migration 009 + 4 new); the 4 new rows
-- should all show has_deduct_marker=true.
-- ─────────────────────────────────────────────────────────────────────────────

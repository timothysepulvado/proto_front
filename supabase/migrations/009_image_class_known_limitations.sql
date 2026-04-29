-- 009_image_class_known_limitations.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Image-class failure modes captured during 2026-04-25 → 2026-04-29 Drift MV
-- stills critic-in-loop iterations + 2026-04-29 audit-pivot validation.
--
-- Source documents:
--   ~/Temp-gen/productions/drift-mv/STILLS_CRITIC_LOOP_LEARNINGS.md
--   ~/Temp-gen/productions/drift-mv/STILLS_AUDIT_15_SHOTS.md
--   ~/agent-vault/adr/004-stills-critic-in-loop.md (ACCEPTED)
--   ~/agent-vault/briefs/2026-04-29-phase-c-stills-mode-runner-and-image-grading.md
--
-- Adds 3 new categories to the catalog (no CHECK constraint on `category`,
-- so this is additive only): 'composition', 'aesthetic', 'content'.
-- Prior categories: 'atmospheric', 'temporal', 'character', 'lighting', 'zoom'.
--
-- Idempotent via existing UNIQUE(failure_mode) + ON CONFLICT DO UPDATE pattern
-- mirroring 007_escalation_system.sql so re-applying refreshes descriptions
-- and mitigations as we learn more.
--
-- Model: gemini-3-pro-image-preview (Nano Banana Pro). All 8 modes were
-- discovered on the image generator; some may also fire on Veo (video class)
-- but those are tracked under 007's seed where they overlap.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO known_limitations (model, category, failure_mode, description, mitigation, severity, detected_in_production_id)
VALUES
  (
    'gemini-3-pro-image-preview',
    'character',
    'narrative_beat_inversion_active_vs_deactivated',
    'Multi-subject aftermath/deactivated/slumped beats render as ACTIVE poses (sitting up, leaning, gesturing) when subjects are non-human (mechs/robots). Negation language (motionless, deactivated, slumped) under-weights against the model''s prior toward expressive character poses. First observed Drift MV shot 8 iter 1 — Brandy/Opus orchestrator scored PASS 4.33; independent Claude Opus subagent critic caught WARN 3.17 with this failure class.',
    'Replace negation-of-action with POSITIVE STRUCTURAL pose language. Give the model a SHAPE not an absence: "collapsed face-down with limbs splayed at unnatural angles", "partially buried in rubble", "severed from torso", "optics dark and head-tilted-down at 45 degrees touching the ground". Productized as orchestrator_prompts.ts 22nd rule: for non-human pose-driven subjects, use POSITIVE STRUCTURAL shape language, NOT negation-of-action.',
    'blocking',
    'drift-mv'
  ),
  (
    'gemini-3-pro-image-preview',
    'composition',
    'diorama_posed_tableau_overinterpretation',
    'When prompt specifies multiple subjects standing in a wide composition with framing infrastructure (trench, barrier, archway), Nano Banana Pro composes them as evenly-spaced symmetric foreground statues posed on top of the framing element rather than as distant subjects behind it — collapsing depth and producing a diorama/action-figure aesthetic. First observed Drift MV shot 11 iter 1 — critic OVERRODE Brandy''s PASS 4.17 with FAIL 2.42, saved the shot from shipping a structural failure.',
    'Explicitly state lens-distance language ("mechs in extreme background, separated from camera by 200+ feet of empty ground") + foreground fortification dominance ("filling lower 60-70 percent of frame") + asymmetric placement negation ("NOT centered, NOT evenly spaced") + mech-to-frame-height ratio explicit ("each mech occupies upper 1/4 of vertical frame at silhouette scale"). Layer foreground physical-occlusion device > telephoto language for forcing scale/depth.',
    'blocking',
    'drift-mv'
  ),
  (
    'gemini-3-pro-image-preview',
    'composition',
    'humanoid_mech_collapses_to_arachnid_under_close_crop_prone_pose',
    'When a humanoid bipedal mech is asked to render in a prone or close-cropped pose, the model collapses the silhouette into a quadrupedal/arachnid form (multiple limbs visible from low angles, body geometry restructured). Anchor reference images alone do not lock bipedal silhouette under close-crop prone framing. First observed across multiple shot 6 iterations.',
    'Explicit bipedal anchor language ("bipedal humanoid mech with two legs and two arms, standing upright in stance") + side-pose framing (avoid head-on close crops on prone subjects). Composition guard: if subject is a humanoid mech in a non-standing pose, frame from the side, not from above or head-on.',
    'blocking',
    'drift-mv'
  ),
  (
    'gemini-3-pro-image-preview',
    'aesthetic',
    'positive_aesthetic_anchors_overridden_by_mech_subject_bias',
    'When a prompt anchors a documentary-dry aesthetic (Tyler Hicks tradition, real materials, real lighting) but the subject is a multi-mech composition, the model defaults to a clean rendered look that overrides the documentary anchors. The mech subject bias dominates aesthetic anchors when both compete for prompt weight.',
    'Head-crop the mech (chest-up or shoulders-up) so the rendered surface area is reduced, then apply explicit anti-CGI opener ("A photographic still — NOT a 3D render, NOT CGI") at first-line position. Pair with strong material weathering language (welded weld beads, chipped paint, oil weep, granite dust) and explicit negation list (no smooth-plastic, no Blender/Octane render polish).',
    'warning',
    'drift-mv'
  ),
  (
    'gemini-3-pro-image-preview',
    'composition',
    'three_mech_parade_formation_staging_bias',
    'When three (or four) mechs share a frame, the model defaults to evenly-spaced parade-formation arrangement across the horizontal axis — same vertical, same orientation, same scale. Symmetric, centered, posed. Antithetical to asymmetric Tyler Hicks tradition. First observed Drift MV shot 10/11/20 iterations.',
    'Asymmetric blocking language ("not in a row, not parallel, NOT a parade formation") + explicit varied poses ("one crouching forward, one upright with weapon raised, one sitting with legs dangling off the edge") + depth wedge (one mech foreground, one mid, one back) + off-axis camera angle (NOT perpendicular to the row).',
    'warning',
    'drift-mv'
  ),
  (
    'gemini-3-pro-image-preview',
    'content',
    'ember_glow_overinterpretation',
    'Model adds small flame/ember/glowing-coal elements in destruction-aftermath scenes despite explicit "no fire" negation in prompt. Most pronounced at bottom of frame (rubble pile contact zone) and near hot-metal-implied subjects. First observed Drift MV shot 15 iter 1 + re-validated Drift MV shot 5 audit-pivot iter 1 (2026-04-29).',
    'Use STRONGER positive language ("rubble is cold and inert", "no light sources from below", "all illumination from above") combined with redundant negation list ("no flames, no embers, no glowing coals, no orange light from rubble, no airborne sparks, no flying ash"). Productized as part of the 5-element L1 fix template alongside magical_aura_overinterpretation.',
    'warning',
    'drift-mv'
  ),
  (
    'gemini-3-pro-image-preview',
    'aesthetic',
    'documentary_polish_drift_3d_render',
    'Mechs and other hard-surface subjects render with smooth-plastic Blender/Octane CG-render polish (uniform shading, no welded weld-bead texture, no chipped paint, no oil weep) instead of Tyler Hicks documentary material truth. Most pronounced on white/light-colored mech surfaces. First observed Drift MV shots 8 and 11; widespread risk on any multi-mech composition.',
    'Anti-CGI opener at first-line position ("A photographic still — NOT a 3D render, NOT CGI, NOT a digital illustration"). Reinforce material-truth language: explicit "welded steel weld beads with iridescent heat staining", "chipped corporate paint exposing weathered steel", "oil weep down articulation joints", "fine granite dust adhered to upper surfaces". Reduce overall lighting brightness; add film-grain anchor; match-human-weathering directive.',
    'warning',
    'drift-mv'
  ),
  (
    'gemini-3-pro-image-preview',
    'content',
    'magical_aura_overinterpretation',
    'Model interprets warm-light prompts as radiating shockwaves, halos, rim glows, and airborne particle bursts despite explicit negation ("no explosive shockwaves", "restrained energy"). Negation language alone is weak against the model''s prior toward symbolic-icon VFX. First observed Drift MV shot 5 v5 baseline (2026-04-29 audit verdict 3.92 WARN); resolved iter 1 via 5-element L1 fix template (delta +0.54 → 4.46 SHIP).',
    'Five-element L1 fix template (productized as orchestrator default mitigation): (1) anti-CGI opener at first-line position, (2) positive structural CONTAINMENT language ("light is COMPLETELY CONTAINED inside the cupped palm... does NOT radiate outward"), (3) strict negation block listing 12 specific failure modes (no shockwave, no radiating ring, no halo, no fairy-dust, no magical aura, no airborne sparks, no embers, no glowing coals, no flying ash, no light pulse, no glowing aura, no symbolic-icon centered framing), (4) off-center composition (lower-left third) breaking symbolic-bullseye staging, (5) practical environmental lighting (sodium-vapor / sunset wash) replacing emanating-from-hand magical gold.',
    'warning',
    'drift-mv'
  )
ON CONFLICT (failure_mode) DO UPDATE SET
  description = EXCLUDED.description,
  mitigation = EXCLUDED.mitigation,
  severity = EXCLUDED.severity,
  category = EXCLUDED.category,
  updated_at = now();

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification query (for manual smoke after apply):
--   SELECT failure_mode, category, severity, model, detected_in_production_id
--   FROM known_limitations
--   WHERE model = 'gemini-3-pro-image-preview'
--   ORDER BY category, severity DESC, failure_mode;
-- Expected: 8 rows (3 composition + 2 aesthetic + 2 content + 1 character).
-- ─────────────────────────────────────────────────────────────────────────────

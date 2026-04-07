# Notes

## Decisions

- `hud.json` remains the source of truth and is imported directly by the UI.
- Dependencies are pinned to exact versions with Node 22 enforced.
- UI now uses Tailwind v4 via the Vite plugin for the CRT/HUD layout.
- Background image and grain overlay are local assets in `src/assets`.

## Follow-ups

- Decide if the HUD data should be fetched at runtime instead of bundled.
- Confirm whether the intake panel should include inline form controls or remain read-only.

# Notes

## Decisions

- `hud.json` remains the source of truth and is imported directly by the UI.
- Dependencies are pinned to exact versions with Node 22 enforced.
- UI now uses Tailwind v4 via the Vite plugin for the CRT/HUD layout.
- Background image and grain overlay are local assets in `src/assets`.
- Local orchestration runs in `os-api`, with `/api` proxied by Vite during dev.
- Run metadata is stored in `os-api/data/runs.json`.
- Intake fields are read-only in the HUD; future edits will be handled via a creator/admin panel.
- No multi-user support for the prototype; emulate RLS later via settings until full app work begins.

## Follow-ups

- Decide if the HUD data should be fetched at runtime instead of bundled.
- Emulate RLS in a settings drawer when needed; defer multi-user storage changes to the full app.
- Investigate runtime data fetch options and how they fit into the admin panel roadmap.

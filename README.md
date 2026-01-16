# BrandStudios OS HUD Prototype

React + TypeScript prototype for the BrandStudios.ai OS HUD. The UI reads from `hud.json` at the repo root and renders an Ironman-inspired transparent HUD with client management, intake workflow, and system notes.

## Requirements

- Node 22.x (see `.nvmrc`)
- npm 10.x

## Quick start

```bash
nvm use
npm install
npm run dev
```

## Notes

- `hud.json` is the source of truth for the UI.
- Styling lives in Tailwind utility classes in `src/App.tsx`, with global defaults in `src/index.css`.
- Static preview backup lives at `docs/static-preview.html`.
- Tailwind v4 is wired through the Vite plugin.
- Background/noise assets live in `src/assets`.

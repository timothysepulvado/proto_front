# Contributing

Thanks for helping improve the BrandStudios OS HUD prototype.

## Setup

```bash
nvm use
npm install
npm run dev
```

## Development guidelines

- Keep `hud.json` as the single source of truth for UI data.
- Use exact dependency versions only (see `DEPENDENCY_POLICY.md`).
- Prefer Tailwind utilities for layout and rhythm. Keep custom CSS in `src/index.css`.
- Add or update documentation when behavior changes.

## Testing

```bash
npm run lint
npm run build
```

## Commits

- Use concise, present-tense messages (example: "Add telemetry panel glow").
- One feature per commit when possible.

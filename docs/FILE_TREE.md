# File Tree

```
HUD
├── .github
│   └── pull_request_template.md
├── docs
│   ├── DEPENDENCY_POLICY.md
│   ├── FILE_TREE.md
│   └── static-preview.html
├── os-api                      # Express backend
│   ├── data                    # SQLite database (gitignored)
│   ├── src
│   │   ├── db.ts               # Database operations
│   │   ├── index.ts            # Express server
│   │   ├── runner.ts           # Run orchestration
│   │   └── types.ts            # Type definitions
│   ├── .env.example
│   ├── .gitignore
│   ├── package.json
│   ├── README.md
│   └── tsconfig.json
├── public
├── src
│   ├── assets
│   │   ├── desktop-bg.png
│   │   └── noise.svg
│   ├── types
│   │   └── hud.ts
│   ├── api.ts                  # API client + SSE
│   ├── App.tsx
│   ├── index.css
│   └── main.tsx
├── .editorconfig
├── .gitattributes
├── .gitignore
├── .npmrc
├── .nvmrc
├── CHANGELOG.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── eslint.config.js
├── hud.json
├── index.html
├── NOTES.md
├── package-lock.json
├── package.json
├── README.md
├── SECURITY.md
├── SUPPORT.md
├── tsconfig.app.json
├── tsconfig.json
├── tsconfig.node.json
└── vite.config.ts
```

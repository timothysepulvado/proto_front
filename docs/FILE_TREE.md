# File Tree

```
HUD
├── .github
│   └── pull_request_template.md
├── docs
│   ├── DEPENDENCY_POLICY.md
│   ├── FILE_TREE.md
│   ├── INTEGRATION_AUDIT_2026-03-31.md
│   ├── INTEGRATION_AUDIT_2026-04-07.md
│   ├── TECH_REQUIREMENTS_CLIENT_IMPLEMENTATION.md
│   ├── archive
│   │   └── NOTES_2026-01.md
│   └── static-preview.html
├── os-api                      # Express backend (Supabase + SSE)
│   ├── data                    # Legacy SQLite dir (gitignored)
│   ├── src
│   │   ├── db.ts               # Supabase database operations
│   │   ├── index.ts            # Express server + routes
│   │   ├── runner.ts           # Run orchestration (stages, demo fallback)
│   │   ├── supabase.ts         # Supabase client initialization
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
│   ├── lib
│   │   └── supabase.ts         # Frontend Supabase client
│   ├── types
│   │   └── hud.ts
│   ├── api.ts                  # API client + SSE
│   ├── App.tsx
│   ├── index.css
│   └── main.tsx
├── supabase
│   └── migrations
│       ├── 001_initial_schema.sql
│       ├── 002_schema_sync.sql
│       └── 003_prompt_evolution.sql
├── worker                      # Python worker for headless execution
│   ├── executors
│   │   ├── __init__.py
│   │   ├── ingest.py
│   │   ├── creative.py
│   │   ├── grading.py
│   │   └── prompt_evolver.py
│   ├── worker.py               # Entry point — polls Supabase for runs
│   ├── config.py               # Configuration (URLs, keys, thresholds)
│   ├── requirements.txt
│   └── setup.sh
├── .editorconfig
├── .gitattributes
├── .gitignore
├── .mcp.json                   # Supabase MCP config
├── .npmrc
├── .nvmrc
├── CHANGELOG.md
├── CLAUDE.md                   # Agent context (architecture, rules, key files)
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── DOCS_INDEX.md               # Documentation index
├── eslint.config.js
├── hud.json                    # Source of truth for client/UI data
├── index.html
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

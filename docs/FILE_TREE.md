# File Tree

```
HUD
├── .github
│   └── pull_request_template.md
├── docs
│   ├── DEPENDENCY_POLICY.md
│   ├── FILE_TREE.md
│   └── static-preview.html
├── os-api                      # Express backend (legacy/local dev)
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
│   ├── components              # React components
│   │   ├── ArtifactGallery.tsx
│   │   ├── CampaignModal.tsx
│   │   ├── CampaignSetupModal.tsx  # V2 multi-step campaign wizard
│   │   ├── DeliverableBuilder.tsx  # Deliverable batch builder
│   │   ├── HITLReviewPanel.tsx     # Review panel with rejection categories
│   │   ├── PromptInput.tsx
│   │   └── index.ts
│   ├── lib
│   │   └── supabase.ts         # Supabase client
│   ├── types
│   │   └── hud.ts
│   ├── api.ts                  # API client + SSE + Campaign V2 APIs
│   ├── App.tsx
│   ├── index.css
│   └── main.tsx
├── supabase
│   └── migrations
│       ├── 001_init.sql
│       ├── 002_campaigns_and_config.sql
│       └── 003_campaigns_v2.sql    # Phase 6.5: retry tracking, rejection categories
├── worker                      # Python workers
│   ├── workers
│   │   ├── __init__.py
│   │   ├── dna_updater.py      # Long-term DNA updates on approval
│   │   ├── generation_worker.py # Temp-gen interface (Nano/Veo/Sora)
│   │   ├── orchestrator.py     # Campaign loop with short-term memory
│   │   ├── prompt_modifier.py  # Rejection → negative prompt mapping
│   │   └── scoring_worker.py   # BDE/Brand Linter scoring
│   ├── .venv                   # Python virtual environment
│   ├── requirements.txt
│   └── worker.py               # Main worker entry point
├── .editorconfig
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcp.json                   # Supabase MCP config
├── .npmrc
├── .nvmrc
├── CHANGELOG.md
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── eslint.config.js
├── HANDOFF.md
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

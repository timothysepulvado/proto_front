@AGENTS.md

## Domain: proto_front

This project is the orchestrator of the **proto_front** umbrella domain (proto_front + BDE + Brand_linter + Temp-gen — all sharing Supabase project `tfbfzepaccvklpabllao` and tmux session `brandy-proto_front`). On session start, also read:
- `~/agent-vault/domains/proto_front/MISSION.md` — domain mission and current phase
- `~/agent-vault/domains/proto_front/ROADMAP.md` — task backlog and architecture coverage
- Tag all daily log entries with `[proto_front]`

The umbrella sub-repos (BDE, Brand_linter, Temp-gen) inherit this domain via path-based detection — they don't need their own CLAUDE.md domain markers; they're part of this same group, same agent logs, same status files.

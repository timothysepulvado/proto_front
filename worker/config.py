"""Worker configuration for BrandStudios OS HUD."""

import os
from pathlib import Path

# Supabase Configuration
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://tfbfzepaccvklpabllao.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "sb_publishable_2_iH1zN1jMxixX0xjvtkSw_BboPk9Wm")

# Tool Paths
# Brand_linter and BDE are now consolidated into brand-engine (in-repo)
# Only Temp-gen remains as an external subprocess tool
TOOL_PATHS = {
    "temp_gen": Path(os.getenv("TEMP_GEN_PATH", "/Users/timothysepulvado/Temp-gen")),
}

# Python environments for subprocess tools (Temp-gen only)
TOOL_VENVS = {
    "temp_gen": TOOL_PATHS["temp_gen"] / ".venv" / "bin" / "python",
}

# Brand Engine API (FastAPI sidecar — optional, worker can import directly)
BRAND_ENGINE_URL = os.getenv("BRAND_ENGINE_URL", "http://localhost:8100")

# Output paths
OUTPUT_BASE = Path(os.getenv("OUTPUT_BASE", "/Users/timothysepulvado/Desktop/T7Sheild/ExternalDrives"))

# Worker settings
POLL_INTERVAL_SECONDS = 2
MAX_CONCURRENT_RUNS = 1

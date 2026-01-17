"""Worker configuration for BrandStudios OS HUD."""

import os
from pathlib import Path

# Supabase Configuration
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://tfbfzepaccvklpabllao.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "sb_publishable_2_iH1zN1jMxixX0xjvtkSw_BboPk9Wm")

# Tool Paths
TOOL_PATHS = {
    "brand_linter": Path("/Users/timothysepulvado/Desktop/Brand_linter/local_quick_setup"),
    "temp_gen": Path("/Users/timothysepulvado/Temp-gen"),
    "bde": Path("/Users/timothysepulvado/BDE"),
}

# Python environments for each tool
TOOL_VENVS = {
    "brand_linter": TOOL_PATHS["brand_linter"] / ".venv" / "bin" / "python",
    "temp_gen": TOOL_PATHS["temp_gen"] / ".venv" / "bin" / "python",
    "bde": TOOL_PATHS["bde"] / "venv" / "bin" / "python",
}

# Output paths
OUTPUT_BASE = Path("/Users/timothysepulvado/Desktop/T7Sheild/ExternalDrives")

# Worker settings
POLL_INTERVAL_SECONDS = 2
MAX_CONCURRENT_RUNS = 1  # Start with 1 for simplicity

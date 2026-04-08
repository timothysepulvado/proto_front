"""Worker configuration for BrandStudios OS HUD."""

import os
import sys
from pathlib import Path

# Supabase Configuration
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://tfbfzepaccvklpabllao.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_KEY", "sb_publishable_2_iH1zN1jMxixX0xjvtkSw_BboPk9Wm")

# Brand Engine — consolidated SDK (replaces BDE + Brand_linter)
# Add brand-engine package root to sys.path so executors can import brand_engine.core
BRAND_ENGINE_ROOT = Path(__file__).parent.parent / "brand-engine"
if BRAND_ENGINE_ROOT.exists():
    sys.path.insert(0, str(BRAND_ENGINE_ROOT))

# Brand asset directories — base path where per-brand asset folders live.
# Each brand has: {BRAND_ASSETS_BASE}/{brand_slug}/reference_images/
# Defaults to Brand_linter's data dir (migration target: brand-engine/data/)
BRAND_ASSETS_BASE = Path(os.getenv(
    "BRAND_ASSETS_BASE",
    "/Users/timothysepulvado/Brand_linter/local_quick_setup/data",
))

# Brand profiles directory (inside brand-engine)
BRAND_PROFILES_DIR = BRAND_ENGINE_ROOT / "data" / "brand_profiles"

# Legacy tool paths (kept for CreativeExecutor / Temp-gen, and as subprocess fallback)
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

# Prompt evolution thresholds
PROMPT_AUTO_EVOLVE_THRESHOLD = 0.7   # Below this, auto-evolve
PROMPT_PASSING_THRESHOLD = 0.85      # At or above this, prompt is good
MAX_EVOLUTIONS_PER_RUN = 5           # Max prompt mutations in a single run

"""Phase B unit test — worker mode-skip safety (ADR-004).

Verifies the worker's `_claim_pending_run` declares an
``OS_API_OWNED_MODES`` allowlist that includes both ``stills`` and
``regrade``, and that the query path uses ``.not_.in_("mode", ...)`` to
filter at the database layer.

worker.py loads heavy env-dependent config at import time (SUPABASE_URL,
PINECONE keys), so a black-box import-the-class test isn't feasible
without large fixtures. Phase B asserts the mechanism via static source
inspection — fast, deterministic, no env required, and it catches the
regression that matters: silently dropping the safety filter.

Usage:
    python -m worker.tests.test_phase_b_worker_safety

Or under pytest:
    pytest worker/tests/test_phase_b_worker_safety.py -v
"""

from __future__ import annotations

import os
import sys
import unittest


REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WORKER_PATH = os.path.join(REPO_ROOT, "worker", "worker.py")


class WorkerModeSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        with open(WORKER_PATH, "r", encoding="utf-8") as fh:
            cls.source = fh.read()

    def test_owned_modes_constant_exists(self) -> None:
        self.assertIn(
            "OS_API_OWNED_MODES",
            self.source,
            "Worker missing OS_API_OWNED_MODES allowlist constant",
        )

    def test_owned_modes_includes_stills_and_regrade(self) -> None:
        # Find the assignment block and assert both modes are listed.
        # We don't parse Python AST here — substring match is sufficient
        # because the constant is defined once and the test fails fast on
        # any rename.
        self.assertIn('"stills"', self.source, "OS_API_OWNED_MODES missing 'stills'")
        self.assertIn('"regrade"', self.source, "OS_API_OWNED_MODES missing 'regrade'")
        # Anchor the assertions to the actual tuple line so a stray string
        # elsewhere in the file doesn't satisfy the test.
        self.assertRegex(
            self.source,
            r"OS_API_OWNED_MODES\s*=\s*\([^)]*\"regrade\"[^)]*\"stills\"[^)]*\)|"
            r"OS_API_OWNED_MODES\s*=\s*\([^)]*\"stills\"[^)]*\"regrade\"[^)]*\)",
            "OS_API_OWNED_MODES tuple must contain both 'regrade' and 'stills'",
        )

    def test_claim_pending_run_uses_not_in_filter(self) -> None:
        # The supabase-py builder uses .not_.in_("mode", ...) to filter at
        # the database layer. Phase B requires this is wired so the worker
        # never even pulls os-api-owned rows down the wire.
        self.assertRegex(
            self.source,
            r"\.not_\.in_\(\s*\"mode\"\s*,\s*list\(\s*self\.OS_API_OWNED_MODES\s*\)\s*\)",
            "Worker must filter via .not_.in_(\"mode\", list(self.OS_API_OWNED_MODES))",
        )

    def test_defensive_post_fetch_check_present(self) -> None:
        # Belt-and-suspenders: even if the query filter is bypassed by a
        # future refactor, the in-memory check should refuse to claim.
        self.assertIn(
            "if mode in self.OS_API_OWNED_MODES:",
            self.source,
            "Worker must double-check mode in OS_API_OWNED_MODES before claiming",
        )


def main() -> int:
    suite = unittest.TestLoader().loadTestsFromTestCase(WorkerModeSafetyTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.path.insert(0, REPO_ROOT)
    raise SystemExit(main())

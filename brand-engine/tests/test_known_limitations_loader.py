"""Coverage for known_limitations_loader.py.

The autouse `mock_supabase_known_limitations` conftest fixture short-circuits
the loader for grade_image_v2 behavior tests. This file disables that fixture
and exercises the real loader (with mocked Supabase clients) so the merge-
blocking 80% coverage gate hits the loader internals.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from brand_engine.core import known_limitations_loader as kll


@pytest.fixture(autouse=True)
def disable_global_mock(monkeypatch):
    """Override the conftest autouse mock for this file — we want to exercise
    the real loader."""
    # Re-import the real module to clobber the autouse mock
    monkeypatch.undo()
    kll.reset_cache()
    yield
    kll.reset_cache()


class TestSupabaseClientMissing:
    def test_returns_empty_when_env_missing(self, monkeypatch, caplog):
        monkeypatch.delenv("SUPABASE_URL", raising=False)
        monkeypatch.delenv("SUPABASE_KEY", raising=False)
        kll.reset_cache()
        result = kll.load_image_class_limitations(force_refresh=True)
        assert result == []
        # Warning logged
        assert any("not set" in r.message for r in caplog.records)


class TestSuccessfulLoad:
    def test_returns_normalized_rows(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "http://fake.supabase")
        monkeypatch.setenv("SUPABASE_KEY", "fake-key")
        kll.reset_cache()

        fake_response = MagicMock()
        fake_response.data = [
            {
                "failure_mode": "magical_aura_overinterpretation",
                "category": "content",
                "description": "warm light reads as halos",
                "mitigation": "5-element template",
                "severity": "warning",
            }
        ]
        fake_table = MagicMock()
        fake_table.select.return_value.eq.return_value.in_.return_value.execute.return_value = fake_response
        fake_client = MagicMock()
        fake_client.table.return_value = fake_table

        with patch("brand_engine.core.known_limitations_loader.create_client", return_value=fake_client):
            rows = kll.load_image_class_limitations(force_refresh=True)

        assert len(rows) == 1
        row = rows[0]
        # All 5 normalized keys present
        assert set(row.keys()) >= {"failure_mode", "category", "description", "mitigation", "severity"}
        assert row["failure_mode"] == "magical_aura_overinterpretation"

    def test_normalizes_missing_mitigation_to_empty_string(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "http://fake")
        monkeypatch.setenv("SUPABASE_KEY", "fake")
        kll.reset_cache()
        fake_response = MagicMock()
        fake_response.data = [
            {"failure_mode": "x", "category": "content", "description": "y", "mitigation": None, "severity": "warning"}
        ]
        fake_table = MagicMock()
        fake_table.select.return_value.eq.return_value.in_.return_value.execute.return_value = fake_response
        fake_client = MagicMock()
        fake_client.table.return_value = fake_table

        with patch("brand_engine.core.known_limitations_loader.create_client", return_value=fake_client):
            rows = kll.load_image_class_limitations(force_refresh=True)
        # None mitigation → "" not None
        assert rows[0]["mitigation"] == ""


class TestCacheTTL:
    def test_second_call_within_ttl_does_not_hit_supabase(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "http://fake")
        monkeypatch.setenv("SUPABASE_KEY", "fake")
        kll.reset_cache()
        fake_response = MagicMock()
        fake_response.data = [
            {"failure_mode": "x", "category": "content", "description": "y", "mitigation": "z", "severity": "warning"}
        ]
        fake_table = MagicMock()
        fake_table.select.return_value.eq.return_value.in_.return_value.execute.return_value = fake_response
        fake_client = MagicMock()
        fake_client.table.return_value = fake_table

        with patch("brand_engine.core.known_limitations_loader.create_client", return_value=fake_client) as mc:
            first = kll.load_image_class_limitations(force_refresh=True)
            second = kll.load_image_class_limitations()

        assert first == second
        # Client constructed once; table() called once (cached on second call)
        assert fake_client.table.call_count == 1

    def test_force_refresh_bypasses_cache(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "http://fake")
        monkeypatch.setenv("SUPABASE_KEY", "fake")
        kll.reset_cache()
        fake_response = MagicMock()
        fake_response.data = []
        fake_table = MagicMock()
        fake_table.select.return_value.eq.return_value.in_.return_value.execute.return_value = fake_response
        fake_client = MagicMock()
        fake_client.table.return_value = fake_table

        with patch("brand_engine.core.known_limitations_loader.create_client", return_value=fake_client):
            kll.load_image_class_limitations(force_refresh=True)
            kll.load_image_class_limitations(force_refresh=True)
        # Two separate Supabase reads
        assert fake_client.table.call_count == 2


class TestSupabaseError:
    def test_query_error_returns_empty_logs_warning(self, monkeypatch, caplog):
        monkeypatch.setenv("SUPABASE_URL", "http://fake")
        monkeypatch.setenv("SUPABASE_KEY", "fake")
        kll.reset_cache()

        fake_table = MagicMock()
        fake_table.select.return_value.eq.return_value.in_.return_value.execute.side_effect = (
            RuntimeError("simulated supabase outage")
        )
        fake_client = MagicMock()
        fake_client.table.return_value = fake_table

        with patch("brand_engine.core.known_limitations_loader.create_client", return_value=fake_client):
            rows = kll.load_image_class_limitations(force_refresh=True)
        # Graceful: empty list, no exception
        assert rows == []
        assert any("Failed to load" in r.message for r in caplog.records)

    def test_create_client_failure_returns_empty(self, monkeypatch, caplog):
        monkeypatch.setenv("SUPABASE_URL", "http://fake")
        monkeypatch.setenv("SUPABASE_KEY", "fake")
        kll.reset_cache()
        with patch(
            "brand_engine.core.known_limitations_loader.create_client",
            side_effect=RuntimeError("create_client crashed"),
        ):
            rows = kll.load_image_class_limitations(force_refresh=True)
        assert rows == []
        assert any("Failed to create Supabase client" in r.message for r in caplog.records)


class TestResetCache:
    def test_reset_cache_forces_re_init(self, monkeypatch):
        monkeypatch.setenv("SUPABASE_URL", "http://fake")
        monkeypatch.setenv("SUPABASE_KEY", "fake")
        kll.reset_cache()
        with patch("brand_engine.core.known_limitations_loader.create_client") as mc:
            mc.return_value.table.return_value.select.return_value.eq.return_value.in_.return_value.execute.return_value = MagicMock(data=[])
            kll.load_image_class_limitations(force_refresh=True)
            kll.reset_cache()
            kll.load_image_class_limitations(force_refresh=True)
        # create_client called twice (cache fully reset)
        assert mc.call_count == 2

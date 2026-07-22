"""Tests for admin diagnostic endpoints:
- GET /api/admin/db-info
- GET /api/admin/exports/list
- GET /api/admin/exports/{filename}  (incl. path-traversal protection)
- Regression: /api/matches, /api/matches/days, /api/ml/stats, /api/upload/skipped
"""
import os
from pathlib import Path

import pytest
import requests

# Backend base URL — problem statement says test against http://localhost:8001,
# but /api routes are also exposed via public EXPO_BACKEND_URL. Use localhost per request.
BASE_URL = "http://localhost:8001"


# ---- Read expected values from /app/backend/.env (source of truth) ----
def _read_env():
    env_path = Path("/app/backend/.env")
    values = {}
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        values[k.strip()] = v
    return values


ENV = _read_env()


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Accept": "application/json"})
    return s


# ---------- /api/admin/db-info ----------
class TestAdminDbInfo:
    def test_db_info_status_200(self, api):
        r = api.get(f"{BASE_URL}/api/admin/db-info", timeout=15)
        assert r.status_code == 200, r.text

    def test_db_info_schema(self, api):
        r = api.get(f"{BASE_URL}/api/admin/db-info", timeout=15)
        data = r.json()
        for key in ["mongo_url", "db_name", "mongo_server", "collections",
                    "env_file", "process_pid"]:
            assert key in data, f"missing key: {key}"
        colls = data["collections"]
        for c in ["matches", "predictions", "market_scores",
                  "family_counters", "settings", "upload_skipped"]:
            assert c in colls, f"missing collection count: {c}"
        assert isinstance(data["process_pid"], int)

    def test_db_info_matches_env(self, api):
        r = api.get(f"{BASE_URL}/api/admin/db-info", timeout=15)
        data = r.json()
        assert data["mongo_url"] == ENV["MONGO_URL"], (
            f"mongo_url mismatch: api={data['mongo_url']} vs env={ENV['MONGO_URL']}"
        )
        assert data["db_name"] == ENV["DB_NAME"], (
            f"db_name mismatch: api={data['db_name']} vs env={ENV['DB_NAME']}"
        )

    def test_db_info_counts_reality(self, api):
        r = api.get(f"{BASE_URL}/api/admin/db-info", timeout=15)
        colls = r.json()["collections"]
        # Expected real state per task description
        assert colls["market_scores"] > 0, f"expected market_scores > 0, got {colls['market_scores']}"
        assert colls["matches"] == 0, f"expected matches == 0, got {colls['matches']}"
        assert colls["predictions"] == 0, f"expected predictions == 0, got {colls['predictions']}"

    def test_db_info_mongo_server_present(self, api):
        r = api.get(f"{BASE_URL}/api/admin/db-info", timeout=15)
        assert isinstance(r.json()["mongo_server"], str) and r.json()["mongo_server"]


# ---------- /api/admin/exports/list ----------
class TestAdminExportsList:
    def test_list_status_200(self, api):
        r = api.get(f"{BASE_URL}/api/admin/exports/list", timeout=15)
        assert r.status_code == 200, r.text

    def test_list_has_zip(self, api):
        r = api.get(f"{BASE_URL}/api/admin/exports/list", timeout=15)
        data = r.json()
        assert "exports" in data
        assert len(data["exports"]) >= 1, "expected at least 1 export ZIP"
        first = data["exports"][0]
        for k in ["name", "url", "size_bytes", "modified_at"]:
            assert k in first
        assert first["name"].endswith(".zip")
        assert first["size_bytes"] > 0


# ---------- /api/admin/exports/{filename} ----------
class TestAdminExportsDownload:
    def test_download_latest_zip(self, api):
        r = api.get(f"{BASE_URL}/api/admin/exports/scoreblast_export_latest.zip",
                    timeout=30, allow_redirects=True)
        assert r.status_code == 200, r.text
        ctype = r.headers.get("content-type", "")
        assert "application/zip" in ctype, f"unexpected content-type: {ctype}"
        assert len(r.content) > 0

    def test_path_traversal_blocked(self, api):
        # Client-side normalization can collapse ../ before send; use raw path
        url = f"{BASE_URL}/api/admin/exports/..%2F.env"
        r = api.get(url, timeout=15, allow_redirects=False)
        # Endpoint validates literal filename after URL-decoding by FastAPI.
        # ".." in the decoded filename -> 400. Also 404 acceptable if not decoded to ..
        assert r.status_code in (400, 404), (
            f"expected 400 (blocked) or 404, got {r.status_code}: {r.text[:200]}"
        )
        # Critical: MUST NOT contain contents of .env
        assert "MONGO_URL" not in r.text
        assert "EMERGENT_LLM_KEY" not in r.text

    def test_path_traversal_blocked_literal_dotdot(self, api):
        # Some servers may not decode; try with plain ../
        r = api.get(f"{BASE_URL}/api/admin/exports/../.env",
                    timeout=15, allow_redirects=False)
        assert r.status_code in (400, 404, 405)
        assert "EMERGENT_LLM_KEY" not in r.text
        assert "MONGO_URL=" not in r.text

    def test_missing_file_404(self, api):
        r = api.get(f"{BASE_URL}/api/admin/exports/does_not_exist_xyz.zip", timeout=15)
        assert r.status_code == 404


# ---------- Regression ----------
class TestRegression:
    def test_get_matches(self, api):
        r = api.get(f"{BASE_URL}/api/matches", timeout=15)
        assert r.status_code == 200, r.text
        assert isinstance(r.json(), list)

    def test_get_matches_days(self, api):
        r = api.get(f"{BASE_URL}/api/matches/days", timeout=15)
        assert r.status_code == 200, r.text
        assert isinstance(r.json(), list)

    def test_ml_stats(self, api):
        r = api.get(f"{BASE_URL}/api/ml/stats", timeout=15)
        assert r.status_code == 200, r.text

    def test_upload_skipped(self, api):
        r = api.get(f"{BASE_URL}/api/upload/skipped", timeout=15)
        assert r.status_code == 200, r.text

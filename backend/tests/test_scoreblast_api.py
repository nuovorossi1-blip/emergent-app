"""Backend tests for ScoreBlast API.

Covers: upload-excel (insert/update/skip/missing-required/estimated odds),
matches CRUD, prediction (Claude Sonnet 4.5), result/bulk, selection,
export/import, ai studio prompt, delete-all.
"""
import json
import time
import pytest


# ----------- HEALTH -----------

def test_health(api_client, base_url):
    r = api_client.get(f"{base_url}/api/", timeout=10)
    assert r.status_code == 200
    data = r.json()
    assert data.get("status") == "ok"


# ----------- CLEAN STATE -----------

@pytest.fixture(scope='module', autouse=True)
def _clean_db(api_client, base_url):
    """Reset DB before this module runs."""
    api_client.delete(f"{base_url}/api/matches/all", timeout=15)
    yield
    api_client.delete(f"{base_url}/api/matches/all", timeout=15)


# ----------- UPLOAD EXCEL -----------

class TestUploadExcel:
    def test_upload_full(self, api_client, base_url, excel_full):
        files = {'file': ('sample.xlsx', excel_full,
                          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}
        r = api_client.post(f"{base_url}/api/upload-excel", files=files, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["inserted"] == 6
        assert data["updated"] == 0
        assert data["skipped"] == 0
        assert data["total_parsed"] == 6

    def test_upload_reupload_skipped(self, api_client, base_url, excel_full):
        files = {'file': ('sample.xlsx', excel_full,
                          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}
        r = api_client.post(f"{base_url}/api/upload-excel", files=files, timeout=30)
        assert r.status_code == 200
        data = r.json()
        # NEW semantics: `skipped` = parser-skipped (missing required odds / missing teams)
        # Unchanged re-uploads are counted in `unchanged`.
        assert data["inserted"] == 0
        assert data["updated"] == 0
        assert data["unchanged"] == 6
        assert data["skipped"] == 0
        assert data["total_parsed"] == 6
        assert data["rows_seen"] == 6

    def test_day_rollover(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/matches/days", timeout=10)
        assert r.status_code == 200
        days = r.json()
        # Excel header "matches, 12 maggio" is in row 1 col A which is parsed as an
        # explicit date header — this sets explicit_day_set=True and disables the
        # time-based rollover. All 6 matches end up on the same day (12 maggio).
        assert len(days) == 1, f"Expected 1 day (explicit header), got {days}"
        from datetime import date
        d1 = date.fromisoformat(days[0])
        assert d1.month == 5 and d1.day == 12

    def test_missing_required_odds_skipped(self, api_client, base_url, excel_missing_required):
        files = {'file': ('miss.xlsx', excel_missing_required,
                          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}
        r = api_client.post(f"{base_url}/api/upload-excel", files=files, timeout=30)
        assert r.status_code == 200
        data = r.json()
        # One row complete (OkA/OkB), one row missing O25 -> skipped during parse
        assert data["total_parsed"] == 1
        assert data["inserted"] == 1

    def test_estimated_odds(self, api_client, base_url, excel_partial):
        files = {'file': ('partial.xlsx', excel_partial,
                          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}
        r = api_client.post(f"{base_url}/api/upload-excel", files=files, timeout=30)
        assert r.status_code == 200
        # find the partial match
        r2 = api_client.get(f"{base_url}/api/matches", params={'q': 'PartialA'}, timeout=10)
        assert r2.status_code == 200
        ms = r2.json()
        # Under new REQUIRED_ODDS this row is VALID because 1X/X2/12 are NOT required.
        assert len(ms) == 1, f"Expected 1 match, got {ms}"
        m = ms[0]
        est = m['odds'].get('estimated', [])
        # Only 1X/X2/12 must be estimated (doubles chance derived from 1/X/2)
        for fld in ('odd_1X', 'odd_X2', 'odd_12'):
            assert fld in est, f"{fld} not in estimated: {est}"
            assert m['odds'].get(fld) is not None, f"{fld} not filled"


# ----------- MATCHES READ -----------

class TestMatches:
    def test_list_all(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/matches", timeout=10)
        assert r.status_code == 200
        ms = r.json()
        assert isinstance(ms, list)
        assert len(ms) >= 6
        # No mongodb _id leaked
        for m in ms:
            assert '_id' not in m
            assert 'id' in m

    def test_filter_by_day(self, api_client, base_url):
        days = api_client.get(f"{base_url}/api/matches/days", timeout=10).json()
        d = days[0]
        r = api_client.get(f"{base_url}/api/matches", params={'day': d}, timeout=10)
        assert r.status_code == 200
        ms = r.json()
        assert len(ms) > 0
        for m in ms:
            assert m['day'] == d

    def test_filter_by_q(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/matches", params={'q': 'Juventus'}, timeout=10)
        assert r.status_code == 200
        ms = r.json()
        assert any('Juventus' in m['squadra1'] or 'Juventus' in m['squadra2'] for m in ms)

    def test_get_one(self, api_client, base_url):
        ms = api_client.get(f"{base_url}/api/matches", timeout=10).json()
        mid = ms[0]['id']
        r = api_client.get(f"{base_url}/api/matches/{mid}", timeout=10)
        assert r.status_code == 200
        m = r.json()
        assert m['id'] == mid
        assert 'prediction' in m  # may be None
        assert '_id' not in m

    def test_get_one_not_found(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/matches/nonexistent-id", timeout=10)
        assert r.status_code == 404


# ----------- AI PREDICTION -----------

class TestPrediction:
    def test_predict(self, api_client, base_url):
        ms = api_client.get(f"{base_url}/api/matches",
                            params={'q': 'Inter Milan'}, timeout=10).json()
        assert ms, "No Inter Milan match"
        mid = ms[0]['id']
        r = api_client.post(f"{base_url}/api/matches/{mid}/predict", timeout=60)
        assert r.status_code == 200, r.text
        pred = r.json()
        assert 'family' in pred
        assert 'main_prediction' in pred
        assert 'confidence' in pred
        assert 'analysis' in pred
        assert 'playable_markets' in pred
        assert '_id' not in pred

    def test_predict_cached(self, api_client, base_url):
        """Second call should return cached prediction quickly."""
        ms = api_client.get(f"{base_url}/api/matches",
                            params={'q': 'Inter Milan'}, timeout=10).json()
        mid = ms[0]['id']
        t0 = time.time()
        r = api_client.post(f"{base_url}/api/matches/{mid}/predict", timeout=15)
        elapsed = time.time() - t0
        assert r.status_code == 200
        assert elapsed < 5, f"Second call took {elapsed}s, expected cached"

    def test_get_match_with_prediction(self, api_client, base_url):
        ms = api_client.get(f"{base_url}/api/matches",
                            params={'q': 'Inter Milan'}, timeout=10).json()
        mid = ms[0]['id']
        r = api_client.get(f"{base_url}/api/matches/{mid}", timeout=10)
        m = r.json()
        assert m['prediction'] is not None
        assert m.get('family') is not None  # mirrored on match
        assert m.get('main_prediction') is not None


# ----------- RESULTS -----------

class TestResults:
    def test_set_single_result(self, api_client, base_url):
        ms = api_client.get(f"{base_url}/api/matches",
                            params={'q': 'Juventus'}, timeout=10).json()
        mid = ms[0]['id']
        r = api_client.post(f"{base_url}/api/matches/{mid}/result",
                            json={'result': '2-1'}, timeout=10)
        assert r.status_code == 200
        # verify via GET
        m = api_client.get(f"{base_url}/api/matches/{mid}", timeout=10).json()
        assert m['result'] == '2-1'

    def test_set_result_not_found(self, api_client, base_url):
        r = api_client.post(f"{base_url}/api/matches/missingid/result",
                            json={'result': '1-1'}, timeout=10)
        assert r.status_code == 404

    def test_bulk_results(self, api_client, base_url):
        ms = api_client.get(f"{base_url}/api/matches", timeout=10).json()
        items = [{'id': ms[0]['id'], 'result': '0-0'},
                 {'id': ms[1]['id'], 'result': '3-2'}]
        r = api_client.post(f"{base_url}/api/results/bulk",
                            json={'items': items}, timeout=15)
        assert r.status_code == 200
        assert r.json()['updated'] == 2
        m0 = api_client.get(f"{base_url}/api/matches/{ms[0]['id']}", timeout=10).json()
        assert m0['result'] == '0-0'


# ----------- SELECTION -----------

class TestSelection:
    def test_select_and_list(self, api_client, base_url):
        ms = api_client.get(f"{base_url}/api/matches", timeout=10).json()
        ids = [m['id'] for m in ms[:3]]
        r = api_client.post(f"{base_url}/api/matches/selection",
                            json={'ids': ids, 'selected': True}, timeout=10)
        assert r.status_code == 200
        sel = api_client.get(f"{base_url}/api/matches/selected/list", timeout=10).json()
        assert len(sel) == 3
        assert set(m['id'] for m in sel) == set(ids)

    def test_clear_selection(self, api_client, base_url):
        r = api_client.post(f"{base_url}/api/selection/clear", timeout=10)
        assert r.status_code == 200
        sel = api_client.get(f"{base_url}/api/matches/selected/list", timeout=10).json()
        assert sel == []


# ----------- EXPORT / IMPORT -----------

class TestExportImport:
    def test_export(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/export", timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert 'matches' in data
        assert 'predictions' in data
        assert 'version' in data
        for m in data['matches']:
            assert '_id' not in m
        for p in data['predictions']:
            assert '_id' not in p

    def test_import_incremental(self, api_client, base_url):
        # Export current state
        export = api_client.get(f"{base_url}/api/export", timeout=15).json()
        # Re-import same payload -> all duplicates skipped
        r = api_client.post(f"{base_url}/api/import", json=export, timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert data['inserted_matches'] == 0
        assert data['skipped_matches'] == len(export['matches'])

    def test_import_new_match(self, api_client, base_url):
        new_match = {
            "id": "test-import-id-1",
            "day": "2030-01-01",
            "time": "12:00",
            "manifestazione": "TEST_IMPORT",
            "squadra1": "TEST_ImpA",
            "squadra2": "TEST_ImpB",
            "odds": {"odd_1": 2.0, "odd_X": 3.0, "odd_2": 3.5,
                     "odd_U25": 1.7, "odd_O25": 2.1, "odd_GG": 1.8, "odd_NG": 1.9,
                     "estimated": []},
            "selected": False,
        }
        payload = {"matches": [new_match], "predictions": []}
        r = api_client.post(f"{base_url}/api/import", json=payload, timeout=15)
        assert r.status_code == 200
        assert r.json()['inserted_matches'] == 1
        # verify
        ms = api_client.get(f"{base_url}/api/matches",
                            params={'q': 'TEST_ImpA'}, timeout=10).json()
        assert len(ms) == 1


# ----------- AI STUDIO PROMPT -----------

class TestAiStudio:
    def test_prompt_csv(self, api_client, base_url):
        # Select some matches
        ms = api_client.get(f"{base_url}/api/matches", timeout=10).json()
        ids = [m['id'] for m in ms[:2]]
        api_client.post(f"{base_url}/api/matches/selection",
                        json={'ids': ids, 'selected': True}, timeout=10)
        r = api_client.get(f"{base_url}/api/aistudio/prompt", timeout=10)
        assert r.status_code == 200
        data = r.json()
        assert 'csv' in data
        assert data['count'] == 2
        assert 'Ora,Lega' in data['csv'] and 'Casa,Ospite' in data['csv']
        # cleanup
        api_client.post(f"{base_url}/api/selection/clear", timeout=10)


# ----------- DELETE ALL -----------

class TestDeleteAll:
    def test_delete_all(self, api_client, base_url):
        r = api_client.delete(f"{base_url}/api/matches/all", timeout=15)
        assert r.status_code == 200
        ms = api_client.get(f"{base_url}/api/matches", timeout=10).json()
        assert ms == []
        days = api_client.get(f"{base_url}/api/matches/days", timeout=10).json()
        assert days == []

"""
Export MongoDB collections to JSON files (one per collection) + a single zip.

Legge MONGO_URL e DB_NAME dallo STESSO backend/.env che il processo backend
in esecuzione utilizza. Verifica in modo esplicito che i valori combacino
con quelli usati dal backend runtime (via GET /api/admin/db-info) per
evitare disallineamenti (es. script che pesca da un DB, backend da un altro).

Rimuove il campo `_id` da ogni documento.

Output:
- /app/backend/exports/<timestamp>/<collection>.json  (individual files)
- /app/backend/exports/scoreblast_export_latest.zip   (single downloadable)
- /app/backend/exports/scoreblast_export_<timestamp>.zip (versioned)
- manifest.json con fingerprint della connessione usata

Usage:
    cd /app/backend && python scripts/export_collections.py
"""
from __future__ import annotations
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv
from pymongo import MongoClient

# ---- Load env from the SAME backend/.env used by the running backend ----
BACKEND_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BACKEND_DIR / ".env"
load_dotenv(ENV_FILE)

COLLECTIONS = [
    "matches",
    "predictions",
    "market_scores",
    "family_counters",
    "settings",
    "upload_skipped",
]

EXPORTS_ROOT = BACKEND_DIR / "exports"
BACKEND_HEALTH_URL = "http://localhost:8001/api/admin/db-info"


def _json_default(o):
    from bson import ObjectId
    if isinstance(o, ObjectId):
        return str(o)
    if isinstance(o, datetime):
        return o.isoformat()
    if isinstance(o, bytes):
        try:
            return o.decode("utf-8")
        except Exception:
            return o.hex()
    return str(o)


def _get_backend_db_info() -> dict | None:
    """Interroga il backend runtime per confermare che stiamo usando lo stesso DB."""
    try:
        r = requests.get(BACKEND_HEALTH_URL, timeout=5)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return None


def main() -> int:
    mongo_url = os.getenv("MONGO_URL")
    db_name = os.getenv("DB_NAME")
    if not mongo_url or not db_name:
        print(f"[FATAL] MONGO_URL or DB_NAME missing from {ENV_FILE}", file=sys.stderr)
        return 1

    # Fingerprint della connessione usata dallo script
    script_fingerprint = {
        "mongo_url": mongo_url,
        "db_name": db_name,
        "env_file": str(ENV_FILE),
        "loaded_at": datetime.now(timezone.utc).isoformat(),
    }

    # Confronta con backend runtime (autoritative source)
    backend_info = _get_backend_db_info()
    if backend_info:
        matches_mongo = backend_info.get("mongo_url") == mongo_url
        matches_db = backend_info.get("db_name") == db_name
        print("=" * 62)
        print("  CONFRONTO CONNESSIONE  (script vs backend runtime)")
        print("=" * 62)
        print(f"  Script MONGO_URL:  {mongo_url}")
        print(f"  Backend MONGO_URL: {backend_info.get('mongo_url')}  "
              f"{'✓ MATCH' if matches_mongo else '✗ DIVERGE!'}")
        print(f"  Script DB_NAME:    {db_name}")
        print(f"  Backend DB_NAME:   {backend_info.get('db_name')}  "
              f"{'✓ MATCH' if matches_db else '✗ DIVERGE!'}")
        print(f"  Mongo server:      {backend_info.get('mongo_server')}")
        print(f"  Backend counts:    {backend_info.get('collections')}")
        print("=" * 62)
        if not (matches_mongo and matches_db):
            print("[WARN] Config divergente! Lo script sta usando parametri "
                  "diversi dal backend live. Controlla env.", file=sys.stderr)
    else:
        print("[WARN] Backend non raggiungibile su localhost:8001 — "
              "impossibile verificare il confronto.")

    # Connessione DB con retry
    client = MongoClient(mongo_url, serverSelectionTimeoutMS=5000)
    try:
        server_info = client.admin.command("hello")
    except Exception as e:
        print(f"[FATAL] Cannot connect to MongoDB at {mongo_url}: {e}", file=sys.stderr)
        return 2

    db = client[db_name]

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    out_dir = EXPORTS_ROOT / ts
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "script_connection": script_fingerprint,
        "backend_runtime_info": backend_info,
        "mongo_server_hello": {
            "host": server_info.get("me"),
            "setName": server_info.get("setName"),
            "connectionId": server_info.get("connectionId"),
        },
        "collections": {},
    }

    total = 0
    for coll_name in COLLECTIONS:
        coll = db[coll_name]
        docs = []
        for doc in coll.find({}):
            doc.pop("_id", None)
            docs.append(doc)

        file_path = out_dir / f"{coll_name}.json"
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(docs, f, ensure_ascii=False, indent=2, default=_json_default)

        manifest["collections"][coll_name] = {
            "count": len(docs),
            "file": file_path.name,
            "bytes": file_path.stat().st_size,
        }
        total += len(docs)
        print(f"  ✓ {coll_name:20} → {len(docs):6} docs → {file_path.name}")

    manifest_path = out_dir / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    # ZIP: versionato + latest
    versioned_zip = EXPORTS_ROOT / f"scoreblast_export_{ts}.zip"
    latest_zip = EXPORTS_ROOT / "scoreblast_export_latest.zip"
    base_name = str(versioned_zip.with_suffix(""))
    shutil.make_archive(base_name, "zip", root_dir=out_dir)
    shutil.copyfile(versioned_zip, latest_zip)

    print()
    print(f"  📦 ZIP versionato: {versioned_zip}")
    print(f"  📦 ZIP latest:     {latest_zip}")
    print(f"  📊 Totale doc:     {total}")
    print(f"  📁 Cartella:       {out_dir}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""
Export MongoDB collections to JSON files (one per collection) + a single zip.

Uses MONGO_URL and DB_NAME from backend/.env.
Removes the internal `_id` field from each document.

Output:
- /app/backend/exports/<timestamp>/<collection>.json  (individual files)
- /app/backend/exports/scoreblast_export_latest.zip   (single downloadable)
- /app/backend/exports/scoreblast_export_<timestamp>.zip (versioned copy)

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

from dotenv import load_dotenv
from pymongo import MongoClient

# Load env from backend/.env regardless of CWD
BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_DIR / ".env")

COLLECTIONS = [
    "matches",
    "predictions",
    "market_scores",
    "family_counters",
    "settings",
    "upload_skipped",
]

EXPORTS_ROOT = BACKEND_DIR / "exports"


def _json_default(o):
    """Fallback JSON encoder for Mongo types (datetime, ObjectId, bytes)."""
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


def main() -> int:
    mongo_url = os.getenv("MONGO_URL")
    db_name = os.getenv("DB_NAME")
    if not mongo_url or not db_name:
        print("[FATAL] MONGO_URL or DB_NAME missing from backend/.env", file=sys.stderr)
        return 1

    client = MongoClient(mongo_url, serverSelectionTimeoutMS=5000)
    try:
        client.admin.command("ping")
    except Exception as e:
        print(f"[FATAL] Cannot connect to MongoDB at {mongo_url}: {e}", file=sys.stderr)
        return 2

    db = client[db_name]

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    out_dir = EXPORTS_ROOT / ts
    out_dir.mkdir(parents=True, exist_ok=True)

    summary = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "mongo_url": mongo_url,
        "db_name": db_name,
        "collections": {},
    }

    total = 0
    for coll_name in COLLECTIONS:
        coll = db[coll_name]
        docs = []
        for doc in coll.find({}):
            doc.pop("_id", None)  # strip internal id
            docs.append(doc)

        file_path = out_dir / f"{coll_name}.json"
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(docs, f, ensure_ascii=False, indent=2, default=_json_default)

        summary["collections"][coll_name] = {
            "count": len(docs),
            "file": file_path.name,
            "bytes": file_path.stat().st_size,
        }
        total += len(docs)
        print(f"  ✓ {coll_name:20} → {len(docs):6} docs → {file_path.name}")

    # Write manifest
    manifest_path = out_dir / "manifest.json"
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    # Build ZIP: versioned + latest
    versioned_zip = EXPORTS_ROOT / f"scoreblast_export_{ts}.zip"
    latest_zip = EXPORTS_ROOT / "scoreblast_export_latest.zip"

    # Zip the timestamped folder contents (flat)
    base_name = str(versioned_zip.with_suffix(""))
    shutil.make_archive(base_name, "zip", root_dir=out_dir)

    # Copy versioned zip to "latest" for stable URL download
    shutil.copyfile(versioned_zip, latest_zip)

    print()
    print(f"  📦 ZIP versionato: {versioned_zip}")
    print(f"  📦 ZIP latest:     {latest_zip}")
    print(f"  📊 Totale doc:     {total}")
    print(f"  📁 Cartella:       {out_dir}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

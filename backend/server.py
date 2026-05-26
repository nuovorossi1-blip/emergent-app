from fastapi import FastAPI, APIRouter, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import io
import re
import math
import json
import logging
import uuid
from pathlib import Path
from datetime import datetime, date, timedelta, timezone
from typing import List, Optional, Dict, Any

import pandas as pd
from pydantic import BaseModel, Field

from emergentintegrations.llm.chat import LlmChat, UserMessage


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

EMERGENT_LLM_KEY = os.environ.get('EMERGENT_LLM_KEY', '')

app = FastAPI()
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# ============================================================
# CONSTANTS
# ============================================================

ITALIAN_MONTHS = {
    'gennaio': 1, 'febbraio': 2, 'marzo': 3, 'aprile': 4,
    'maggio': 5, 'giugno': 6, 'luglio': 7, 'agosto': 8,
    'settembre': 9, 'ottobre': 10, 'novembre': 11, 'dicembre': 12,
}

# Excel column indices (0-based) per user's spec
COL_ORA = 0      # A
COL_MANIF = 1    # B
COL_SQ1 = 4      # E
COL_SQ2 = 5      # F
COL_1 = 8        # I
COL_X = 9        # J
COL_2 = 10       # K
COL_1X = 15      # P
COL_X2 = 16      # Q
COL_12 = 17      # R
COL_U15 = 18     # S
COL_O15 = 19     # T
COL_U25 = 20     # U
COL_O25 = 21     # V
COL_U35 = 22     # W
COL_O35 = 23     # X
COL_GG = 24      # Y
COL_NG = 25      # Z

REQUIRED_ODDS = ['odd_1', 'odd_X', 'odd_2', 'odd_U25', 'odd_O25', 'odd_GG', 'odd_NG']


# ============================================================
# MODELS
# ============================================================

class MatchOdds(BaseModel):
    odd_1: Optional[float] = None
    odd_X: Optional[float] = None
    odd_2: Optional[float] = None
    odd_1X: Optional[float] = None
    odd_X2: Optional[float] = None
    odd_12: Optional[float] = None
    odd_U15: Optional[float] = None
    odd_O15: Optional[float] = None
    odd_U25: Optional[float] = None
    odd_O25: Optional[float] = None
    odd_U35: Optional[float] = None
    odd_O35: Optional[float] = None
    odd_GG: Optional[float] = None
    odd_NG: Optional[float] = None
    estimated: List[str] = Field(default_factory=list)


class Match(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    day: str  # YYYY-MM-DD
    time: str  # HH:MM
    manifestazione: str
    squadra1: str
    squadra2: str
    odds: MatchOdds
    result: Optional[str] = None  # e.g. "2-1"
    family: Optional[str] = None
    main_prediction: Optional[str] = None
    selected: bool = False
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class ResultUpdate(BaseModel):
    result: str


class BulkResult(BaseModel):
    items: List[Dict[str, str]]  # [{id, result}]


class SelectionUpdate(BaseModel):
    ids: List[str]
    selected: bool


# ============================================================
# EXCEL PARSER
# ============================================================

DATE_HEADER_RE = re.compile(
    r'(\d{1,2})\s*(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)',
    re.IGNORECASE,
)


def parse_date_header(cell_value, base_year: int) -> Optional[date]:
    """Detect a row that is a date header like 'lunedì, 25 maggio' or '12 maggio'."""
    if cell_value is None or (isinstance(cell_value, float) and pd.isna(cell_value)):
        return None
    s = str(cell_value).lower()
    m = DATE_HEADER_RE.search(s)
    if not m:
        return None
    try:
        return date(base_year, ITALIAN_MONTHS[m.group(2).lower()], int(m.group(1)))
    except (ValueError, KeyError):
        return None


def parse_first_day(raw_df: pd.DataFrame) -> Optional[date]:
    """Scan first ~15 rows for an Italian date like '12 maggio' or 'lunedì, 25 maggio'."""
    base_year = datetime.now().year
    for r in range(min(20, len(raw_df))):
        for c in range(min(6, raw_df.shape[1])):
            d = parse_date_header(raw_df.iat[r, c], base_year)
            if d:
                return d
    return None


def parse_time(val) -> Optional[str]:
    """Return HH:MM string or None."""
    if pd.isna(val):
        return None
    s = str(val).strip()
    # numeric (excel time fraction)
    try:
        f = float(s)
        if 0 <= f < 1:
            total_min = round(f * 24 * 60)
            return f"{total_min // 60:02d}:{total_min % 60:02d}"
    except (ValueError, TypeError):
        pass
    m = re.search(r'(\d{1,2})[:.](\d{2})', s)
    if m:
        h, mi = int(m.group(1)), int(m.group(2))
        if 0 <= h < 24 and 0 <= mi < 60:
            return f"{h:02d}:{mi:02d}"
    # HHMM like 1130
    m = re.fullmatch(r'(\d{3,4})', s)
    if m:
        n = int(m.group(1))
        h, mi = n // 100, n % 100
        if 0 <= h < 24 and 0 <= mi < 60:
            return f"{h:02d}:{mi:02d}"
    return None


def parse_odd(val) -> Optional[float]:
    if pd.isna(val):
        return None
    s = str(val).strip().replace(',', '.')
    try:
        f = float(s)
        if f >= 1.01:
            return round(f, 2)
    except (ValueError, TypeError):
        pass
    return None


def estimate_missing(odds: dict) -> List[str]:
    """Fill missing odds with estimates and return list of estimated field names."""
    estimated = []

    # Doppia chance
    if not odds.get('odd_1X') and odds.get('odd_1') and odds.get('odd_X'):
        odds['odd_1X'] = round((odds['odd_1'] * odds['odd_X']) / (odds['odd_1'] + odds['odd_X']), 2)
        estimated.append('odd_1X')
    if not odds.get('odd_X2') and odds.get('odd_X') and odds.get('odd_2'):
        odds['odd_X2'] = round((odds['odd_X'] * odds['odd_2']) / (odds['odd_X'] + odds['odd_2']), 2)
        estimated.append('odd_X2')
    if not odds.get('odd_12') and odds.get('odd_1') and odds.get('odd_2'):
        odds['odd_12'] = round((odds['odd_1'] * odds['odd_2']) / (odds['odd_1'] + odds['odd_2']), 2)
        estimated.append('odd_12')

    # U/O complementary pair
    def complement(o):
        return round(1 / (1 - 1 / o), 2) if o and o > 1.01 else None

    if not odds.get('odd_U15') and odds.get('odd_O15'):
        odds['odd_U15'] = complement(odds['odd_O15']); estimated.append('odd_U15')
    if not odds.get('odd_O15') and odds.get('odd_U15'):
        odds['odd_O15'] = complement(odds['odd_U15']); estimated.append('odd_O15')
    if not odds.get('odd_U35') and odds.get('odd_O35'):
        odds['odd_U35'] = complement(odds['odd_O35']); estimated.append('odd_U35')
    if not odds.get('odd_O35') and odds.get('odd_U35'):
        odds['odd_O35'] = complement(odds['odd_U35']); estimated.append('odd_O35')

    # Derive O1.5/O3.5 from O2.5 via Poisson approx
    if odds.get('odd_O25'):
        lam = lambda_from_o25(odds['odd_O25'])
        if not odds.get('odd_O15'):
            p_o15 = 1 - poisson_cdf(1, lam)
            if p_o15 > 0.01:
                odds['odd_O15'] = round(1 / p_o15, 2); estimated.append('odd_O15')
                odds['odd_U15'] = complement(odds['odd_O15']); estimated.append('odd_U15')
        if not odds.get('odd_O35'):
            p_o35 = 1 - poisson_cdf(3, lam)
            if p_o35 > 0.01:
                odds['odd_O35'] = round(1 / p_o35, 2); estimated.append('odd_O35')
                odds['odd_U35'] = complement(odds['odd_O35']); estimated.append('odd_U35')

    return estimated


def poisson_cdf(k: int, lam: float) -> float:
    s = 0.0
    for i in range(k + 1):
        s += math.exp(-lam) * (lam ** i) / math.factorial(i)
    return s


def lambda_from_o25(odd_o25: float) -> float:
    """Binary search lambda so P(goals>=3) = 1/odd_o25."""
    target = 1 / odd_o25
    lo, hi = 0.1, 8.0
    for _ in range(40):
        mid = (lo + hi) / 2
        p_o25 = 1 - poisson_cdf(2, mid)
        if p_o25 < target:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def parse_excel_bytes(content: bytes, filename: str) -> List[dict]:
    """Parse the Excel file. Return list of match dicts."""
    bio = io.BytesIO(content)
    if filename.lower().endswith('.xls'):
        raw = pd.read_excel(bio, header=None, engine='xlrd')
    else:
        raw = pd.read_excel(bio, header=None, engine='openpyxl')

    base_year = datetime.now().year
    first_day = parse_first_day(raw)
    if not first_day:
        first_day = datetime.now().date()
        logger.warning("No date header detected; defaulting to today %s", first_day)

    matches = []
    current_day = first_day
    prev_time_min: Optional[int] = None
    explicit_day_set = False  # becomes True after we encounter an in-file date header

    for idx in range(len(raw)):
        row = raw.iloc[idx]

        # Check first column for a date header (e.g. "lunedì, 25 maggio")
        date_in_row = parse_date_header(row.iat[COL_ORA] if COL_ORA < len(row) else None, base_year)
        if date_in_row:
            current_day = date_in_row
            prev_time_min = None  # reset
            explicit_day_set = True
            continue

        ora_raw = row.iat[COL_ORA] if COL_ORA < len(row) else None
        time_str = parse_time(ora_raw)
        if not time_str:
            continue

        sq1 = str(row.iat[COL_SQ1]).strip() if COL_SQ1 < len(row) and pd.notna(row.iat[COL_SQ1]) else ''
        sq2 = str(row.iat[COL_SQ2]).strip() if COL_SQ2 < len(row) and pd.notna(row.iat[COL_SQ2]) else ''
        if not sq1 or not sq2:
            continue

        manif = str(row.iat[COL_MANIF]).strip() if COL_MANIF < len(row) and pd.notna(row.iat[COL_MANIF]) else 'N/D'

        # Day rollover only when there is NO explicit date header in the file
        cur_min = int(time_str[:2]) * 60 + int(time_str[3:])
        if not explicit_day_set and prev_time_min is not None and cur_min < prev_time_min:
            current_day = current_day + timedelta(days=1)
        prev_time_min = cur_min

        def col(i):
            return row.iat[i] if i < len(row) else None

        odds = {
            'odd_1': parse_odd(col(COL_1)),
            'odd_X': parse_odd(col(COL_X)),
            'odd_2': parse_odd(col(COL_2)),
            'odd_1X': parse_odd(col(COL_1X)),
            'odd_X2': parse_odd(col(COL_X2)),
            'odd_12': parse_odd(col(COL_12)),
            'odd_U15': parse_odd(col(COL_U15)),
            'odd_O15': parse_odd(col(COL_O15)),
            'odd_U25': parse_odd(col(COL_U25)),
            'odd_O25': parse_odd(col(COL_O25)),
            'odd_U35': parse_odd(col(COL_U35)),
            'odd_O35': parse_odd(col(COL_O35)),
            'odd_GG': parse_odd(col(COL_GG)),
            'odd_NG': parse_odd(col(COL_NG)),
        }

        # Skip if any required odd missing
        if any(odds.get(k) is None for k in REQUIRED_ODDS):
            continue

        estimated = estimate_missing(odds)

        matches.append({
            'day': current_day.isoformat(),
            'time': time_str,
            'manifestazione': manif,
            'squadra1': sq1,
            'squadra2': sq2,
            'odds': {**odds, 'estimated': estimated},
        })

    return matches


# ============================================================
# AI PREDICTION
# ============================================================

PREDICTION_SYSTEM = """Sei un analista esperto di scommesse calcistiche. Analizzi le quote di una partita e fornisci pronostici basandoti SOLO sulla distribuzione delle quote (logaritmica vs lineare vs esponenziale).

REGOLE:
- Quote 1X2 sotto 1.85 indicano forte preferenza del book; sopra 1.85 nessuna preferenza chiara.
- Confronta U1.5 vs U2.5 vs U3.5: se la successione è lineare, gol distribuiti uniformemente. Se logaritmica inversa (gap U1.5→U2.5 enorme, U2.5→U3.5 piccolo), minimo 2 gol previsti.
- Confronta O1.5 vs O2.5 vs O3.5: se gap O2.5→O3.5 enorme (esponenziale), tetto massimo 3-4 gol.
- GG/NG: se quote vicine, distribuzione gol incerta, GG non giocabile.
- Identifica pavimento minimo e tetto massimo gol.
- Famiglie: OFFENSIVA_PULITA, OFFENSIVA_SPORCA, RANGE_CONTROLLATO, CHIUSA_PROTETTA, DOMINANZA_CON_TETTO, INSTABILE.

OUTPUT IN JSON (solo JSON, niente markdown):
{
  "family": "RANGE_CONTROLLATO",
  "analysis": "breve analisi 2-3 righe della distribuzione",
  "playable_markets": [
    {"market": "O1.5", "reasoning": "perché"},
    {"market": "MG 2-4", "reasoning": "perché"}
  ],
  "main_prediction": "O1.5",
  "confidence": "Media",
  "min_goals": 2,
  "max_goals": 4
}"""


def build_match_prompt(match: dict) -> str:
    o = match['odds']
    def fmt(k, label):
        v = o.get(k)
        if v is None:
            return f"{label} N/D"
        est = " (stima)" if k in o.get('estimated', []) else ""
        return f"{label} {v}{est}"
    parts = [
        fmt('odd_1', '1'), fmt('odd_X', 'X'), fmt('odd_2', '2'),
        fmt('odd_1X', '1X'), fmt('odd_X2', 'X2'), fmt('odd_12', '12'),
        fmt('odd_U15', 'U1.5'), fmt('odd_O15', 'O1.5'),
        fmt('odd_U25', 'U2.5'), fmt('odd_O25', 'O2.5'),
        fmt('odd_U35', 'U3.5'), fmt('odd_O35', 'O3.5'),
        fmt('odd_GG', 'GG'), fmt('odd_NG', 'NG'),
    ]
    return (
        f"PARTITA: {match['manifestazione']} · {match['time']} "
        f"{match['squadra1']} vs {match['squadra2']}\n"
        f"Quote: {' | '.join(parts)}\n"
        f"Analizza e restituisci SOLO JSON."
    )


async def run_ai_prediction(match: dict) -> dict:
    if not EMERGENT_LLM_KEY:
        raise HTTPException(500, "EMERGENT_LLM_KEY not configured")
    chat = LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=f"pred-{match['id']}",
        system_message=PREDICTION_SYSTEM,
    ).with_model("anthropic", "claude-sonnet-4-5-20250929")
    msg = UserMessage(text=build_match_prompt(match))
    response = await chat.send_message(msg)
    text = response if isinstance(response, str) else str(response)
    # Extract JSON
    m = re.search(r'\{.*\}', text, re.DOTALL)
    if not m:
        return {"family": "INSTABILE", "analysis": text[:200], "playable_markets": [],
                "main_prediction": None, "confidence": "Bassa"}
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return {"family": "INSTABILE", "analysis": text[:200], "playable_markets": [],
                "main_prediction": None, "confidence": "Bassa"}


# ============================================================
# ROUTES
# ============================================================

@api_router.get("/")
async def root():
    return {"message": "ScoreBlast API", "status": "ok"}


@api_router.post("/upload-excel")
async def upload_excel(file: UploadFile = File(...)):
    content = await file.read()
    try:
        parsed = parse_excel_bytes(content, file.filename or 'upload.xlsx')
    except Exception as e:
        logger.exception("excel parse error")
        raise HTTPException(400, f"Errore parsing Excel: {e}")

    inserted, updated, skipped = 0, 0, 0
    for m in parsed:
        key = {
            'squadra1': m['squadra1'],
            'squadra2': m['squadra2'],
            'day': m['day'],
        }
        existing = await db.matches.find_one(key, {'_id': 0})
        new_odds = m['odds']
        if existing:
            # Overwrite only if odds changed
            old_odds = {k: v for k, v in existing.get('odds', {}).items() if k != 'estimated'}
            new_compare = {k: v for k, v in new_odds.items() if k != 'estimated'}
            if old_odds == new_compare:
                skipped += 1
                continue
            await db.matches.update_one(
                key,
                {'$set': {
                    'odds': new_odds,
                    'time': m['time'],
                    'manifestazione': m['manifestazione'],
                    'updated_at': datetime.now(timezone.utc).isoformat(),
                }}
            )
            # Invalidate prediction since odds changed
            await db.predictions.delete_many({'match_id': existing['id']})
            updated += 1
        else:
            doc = Match(
                day=m['day'], time=m['time'],
                manifestazione=m['manifestazione'],
                squadra1=m['squadra1'], squadra2=m['squadra2'],
                odds=MatchOdds(**m['odds']),
            ).dict()
            await db.matches.insert_one(doc)
            inserted += 1

    return {
        "inserted": inserted,
        "updated": updated,
        "skipped": skipped,
        "total_parsed": len(parsed),
    }


@api_router.get("/matches")
async def get_matches(day: Optional[str] = None, q: Optional[str] = None):
    query: Dict[str, Any] = {}
    if day:
        query['day'] = day
    if q:
        query['$or'] = [
            {'squadra1': {'$regex': q, '$options': 'i'}},
            {'squadra2': {'$regex': q, '$options': 'i'}},
            {'manifestazione': {'$regex': q, '$options': 'i'}},
        ]
    docs = await db.matches.find(query, {'_id': 0}).sort([('day', 1), ('time', 1)]).to_list(5000)
    return docs


@api_router.get("/matches/days")
async def get_days():
    days = await db.matches.distinct('day')
    days.sort()
    return days


@api_router.get("/matches/{match_id}")
async def get_match(match_id: str):
    doc = await db.matches.find_one({'id': match_id}, {'_id': 0})
    if not doc:
        raise HTTPException(404, "Match not found")
    pred = await db.predictions.find_one({'match_id': match_id}, {'_id': 0})
    doc['prediction'] = pred
    return doc


@api_router.post("/matches/{match_id}/predict")
async def predict_match(match_id: str):
    match = await db.matches.find_one({'id': match_id}, {'_id': 0})
    if not match:
        raise HTTPException(404, "Match not found")
    existing = await db.predictions.find_one({'match_id': match_id}, {'_id': 0})
    if existing:
        return existing
    try:
        result = await run_ai_prediction(match)
    except Exception as e:
        logger.exception("ai predict error")
        raise HTTPException(500, f"AI error: {e}")
    record = {
        'id': str(uuid.uuid4()),
        'match_id': match_id,
        **result,
        'created_at': datetime.now(timezone.utc).isoformat(),
    }
    await db.predictions.insert_one(record)
    await db.matches.update_one(
        {'id': match_id},
        {'$set': {
            'family': result.get('family'),
            'main_prediction': result.get('main_prediction'),
        }},
    )
    record.pop('_id', None)
    return record


@api_router.post("/matches/{match_id}/result")
async def set_result(match_id: str, body: ResultUpdate):
    res = await db.matches.update_one(
        {'id': match_id},
        {'$set': {'result': body.result, 'updated_at': datetime.now(timezone.utc).isoformat()}},
    )
    if res.matched_count == 0:
        raise HTTPException(404, "Match not found")
    return {"ok": True}


@api_router.post("/results/bulk")
async def bulk_results(body: BulkResult):
    count = 0
    for item in body.items:
        if 'id' in item and 'result' in item:
            r = await db.matches.update_one(
                {'id': item['id']},
                {'$set': {'result': item['result'], 'updated_at': datetime.now(timezone.utc).isoformat()}},
            )
            count += r.matched_count
    return {"updated": count}


@api_router.post("/matches/selection")
async def update_selection(body: SelectionUpdate):
    await db.matches.update_many(
        {'id': {'$in': body.ids}},
        {'$set': {'selected': body.selected}},
    )
    return {"ok": True}


@api_router.get("/matches/selected/list")
async def selected_list():
    docs = await db.matches.find({'selected': True}, {'_id': 0}).sort([('day', 1), ('time', 1)]).to_list(1000)
    return docs


@api_router.post("/selection/clear")
async def clear_selection():
    await db.matches.update_many({'selected': True}, {'$set': {'selected': False}})
    return {"ok": True}


@api_router.get("/export")
async def export_db():
    matches = await db.matches.find({}, {'_id': 0}).to_list(100000)
    predictions = await db.predictions.find({}, {'_id': 0}).to_list(100000)
    return {
        "version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "matches": matches,
        "predictions": predictions,
    }


@api_router.post("/import")
async def import_db(payload: Dict[str, Any]):
    matches = payload.get('matches', [])
    predictions = payload.get('predictions', [])
    inserted, skipped = 0, 0
    for m in matches:
        key = {'squadra1': m['squadra1'], 'squadra2': m['squadra2'], 'day': m['day']}
        existing = await db.matches.find_one(key)
        if existing:
            skipped += 1
            continue
        m.pop('_id', None)
        await db.matches.insert_one(m)
        inserted += 1
    for p in predictions:
        p.pop('_id', None)
        existing = await db.predictions.find_one({'match_id': p.get('match_id')})
        if not existing:
            await db.predictions.insert_one(p)
    return {"inserted_matches": inserted, "skipped_matches": skipped,
            "inserted_predictions": len(predictions)}


@api_router.delete("/matches/all")
async def delete_all():
    await db.matches.delete_many({})
    await db.predictions.delete_many({})
    return {"ok": True}


# Generate framework prompt for AI Studio
@api_router.get("/aistudio/prompt")
async def aistudio_prompt():
    selected = await db.matches.find({'selected': True}, {'_id': 0}).to_list(1000)
    if not selected:
        selected = await db.matches.find({}, {'_id': 0}).limit(20).to_list(20)
    csv_lines = ["data,ora,lega,casa,ospite"]
    for m in selected:
        csv_lines.append(f"{m['day']},{m['time']},{m['manifestazione']},{m['squadra1']},{m['squadra2']}")
    csv_text = "\n".join(csv_lines)
    return {"csv": csv_text, "count": len(selected)}


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()

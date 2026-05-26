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

def evaluate_market(market: str, home: int, away: int) -> Optional[bool]:
    """Return True if market won, False if lost, None if not evaluable."""
    total = home + away
    m = market.strip().upper().replace(" ", "")
    # Combo (DC ... + U/O ...)
    if "+" in m:
        parts = [p.strip() for p in market.upper().split("+")]
        results = [evaluate_market(p, home, away) for p in parts]
        if any(r is None for r in results):
            return None
        return all(results)
    # Sostituzioni
    if m in ("1",): return home > away
    if m in ("X",): return home == away
    if m in ("2",): return away > home
    if m in ("1X", "DC1X"): return home >= away
    if m in ("X2", "DCX2"): return away >= home
    if m in ("12", "DC12"): return home != away
    if m.startswith("O") or m.startswith("OVER"):
        try:
            n = float(re.findall(r"[\d.]+", m)[0])
            return total > n
        except (IndexError, ValueError):
            return None
    if m.startswith("U") or m.startswith("UNDER"):
        try:
            n = float(re.findall(r"[\d.]+", m)[0])
            return total < n
        except (IndexError, ValueError):
            return None
    if m in ("GG", "BTTS"): return home > 0 and away > 0
    if m in ("NG", "NOBTTS"): return home == 0 or away == 0
    if "MG" in m and "2-4" in m:
        if "CASA" in m: return 2 <= home <= 4
        if "OSPITE" in m: return 2 <= away <= 4
        return 2 <= total <= 4
    return None


def parse_result(result_str: str) -> Optional[tuple]:
    """Parse '2-1' or '2:1' into (home, away)."""
    if not result_str: return None
    m = re.match(r"\s*(\d+)\s*[-:.]\s*(\d+)\s*", result_str)
    if not m: return None
    return int(m.group(1)), int(m.group(2))


async def update_market_scores(match: dict, prediction: dict, home: int, away: int):
    """Update per-family market scores based on actual result vs predicted markets."""
    family = prediction.get("family", "INSTABILE")
    playable = prediction.get("playable_markets") or []
    markets_to_update = [m.get("market") for m in playable if m.get("market")]
    if prediction.get("main_prediction") and prediction["main_prediction"] not in markets_to_update:
        markets_to_update.insert(0, prediction["main_prediction"])

    for market in markets_to_update:
        outcome = evaluate_market(market, home, away)
        if outcome is None:
            continue
        update_doc = {"$inc": {("wins" if outcome else "losses"): 1, "total": 1}}
        await db.market_scores.update_one(
            {"family": family, "market": market},
            update_doc,
            upsert=True,
        )

    # ALSO evaluate ALL standard markets (winners that weren't predicted) to discover good markets
    standard_markets = [
        "1", "X", "2", "1X", "X2", "12",
        "O1.5", "U1.5", "O2.5", "U2.5", "O3.5", "U3.5",
        "GG", "NG", "MG 2-4 totali", "MG 2-4 casa", "MG 2-4 ospite",
        "DC 1X + U3.5", "DC X2 + U3.5", "DC 1X + O1.5", "DC X2 + O1.5",
    ]
    for market in standard_markets:
        if market in markets_to_update:
            continue
        outcome = evaluate_market(market, home, away)
        if outcome is None:
            continue
        # Award "missed opportunity" only when this market WON but wasn't predicted
        if outcome:
            await db.market_scores.update_one(
                {"family": family, "market": market},
                {"$inc": {"missed_wins": 1}},
                upsert=True,
            )


async def get_family_stats(family: str) -> str:
    """Build a feedback string from historical scores for this family."""
    docs = await db.market_scores.find({"family": family}, {"_id": 0}).to_list(100)
    if not docs:
        return ""
    lines = []
    for d in docs:
        total = d.get("total", 0)
        wins = d.get("wins", 0)
        missed = d.get("missed_wins", 0)
        if total == 0 and missed == 0:
            continue
        rate = (wins / total * 100) if total > 0 else 0
        lines.append(f"  - {d['market']}: {wins}/{total} ({rate:.0f}%)" + (f" | persi {missed} opportunità" if missed else ""))
    if not lines:
        return ""
    return "STORICO FAMIGLIA " + family + ":\n" + "\n".join(lines)


PREDICTION_SYSTEM = """Sei un analista esperto di scommesse calcistiche. Analizzi le quote di una partita e fornisci pronostici basati SOLO sulla distribuzione delle quote (gap logaritmico/lineare/esponenziale).

═══════════════════════════════════════
FASE 1 — IDENTIFICA LA FAMIGLIA (obbligatoria, prima di scegliere mercati)
═══════════════════════════════════════
Scegli UNA delle 6 famiglie usando le quote:

• OFFENSIVA_PULITA: O2.5 < 1.65, O3.5 < 2.50, GG < 1.70, NG > 1.90, U1.5 > 4.50.
  → Tante reti, attacchi netti, partita scoperta.

• OFFENSIVA_SPORCA: O2.5 < 1.85, O3.5 < 3.00, GG vicino a NG (1.80-2.00 entrambe), 1X2 senza favorita chiara.
  → Tanti gol probabili ma chi segna è incerto.

• RANGE_CONTROLLATO: O1.5 < 1.40, O2.5 tra 1.70-2.10, O3.5 > 3.20, U3.5 < 1.30.
  → Pavimento minimo 2 gol, tetto massimo 3-4 gol. Il classico 2-4 gol.

• CHIUSA_PROTETTA: O2.5 > 2.10, U2.5 < 1.65, U3.5 < 1.15, NG < 1.85, GG > 1.95.
  → Difese forti, pochi gol, partita tattica.

• DOMINANZA_CON_TETTO: 1 < 1.55 OPPURE 2 < 1.55 (favorita netta), O3.5 > 3.50, U3.5 < 1.25.
  → Favorita vince ma senza goleada. 1-0, 2-0, 2-1.

• INSTABILE: Quote 1X2 tutte > 2.40, GG/NG entrambe 1.70-1.95, U/O quasi simmetrici.
  → Nessun segnale, evitare.

═══════════════════════════════════════
FASE 2 — REGOLE DI SCELTA MERCATI (basate sulla famiglia)
═══════════════════════════════════════

PER FAMIGLIA, l'ordine di preferenza dei mercati è:

• OFFENSIVA_PULITA → ordine: O2.5, GG, O1.5, MG 2-4 totali, Combo DC+O1.5
• OFFENSIVA_SPORCA → ordine: O1.5, MG 2-4 totali, O2.5, Combo X+O1.5 se equilibrio
• RANGE_CONTROLLATO → ordine: MG 2-4 totali, O1.5+U3.5 combo, U3.5, O1.5
• CHIUSA_PROTETTA → ordine: U3.5, U2.5, NG, MG 2-4 casa o ospite (a seconda della favorita), Combo DC+U3.5
• DOMINANZA_CON_TETTO → ordine: 1 secco (se quota 1 ≤ 1.50) oppure 2 secco (se quota 2 ≤ 1.50), 1X (se 1.50 < 1 ≤ 1.85), X2 (se 1.50 < 2 ≤ 1.85), MG 2-4 casa/ospite, U3.5, Combo DC+U3.5
• INSTABILE → ordine: nessun mercato valutabile, eventualmente solo NG o U3.5 con fiducia Bassa

REGOLE FORZANTI (devi rispettarle):
- Se quota 1 ≤ 1.50 OPPURE quota 2 ≤ 1.50, INSERISCI "1" o "2" SECCO come primo o secondo mercato.
- Se quota 1 tra 1.51 e 1.85, valuta "1X" come copertura.
- Se quota 2 tra 1.51 e 1.85, valuta "X2" come copertura.
- INSERISCI SEMPRE almeno una opzione MULTIGOAL tra: "MG 2-4 totali", "MG 2-4 casa", "MG 2-4 ospite" quando la famiglia è RANGE_CONTROLLATO, DOMINANZA_CON_TETTO o CHIUSA_PROTETTA.
- INSERISCI SEMPRE almeno una opzione COMBO tra: "DC 1X + U3.5", "DC X2 + U3.5", "DC 1X + O1.5", "DC X2 + O1.5", "DC 12 + O1.5" quando applicabile.
- Non bocciare 1 o 2 secco se la quota è bassa e il gap con X e l'altro segno è netto.
- "MG 2-4 casa" si gioca quando 1 è favorita ma O3.5 > 3.50 (tetto): mette pavimento+tetto + scelta vincente.
- "MG 2-4 ospite" stessa logica con 2 favorita.

═══════════════════════════════════════
FASE 3 — RANKING
═══════════════════════════════════════
Restituisci 3-5 mercati ordinati dal PIÙ PROBABILE al MENO PROBABILE.
Il "main_prediction" è il primo (più probabile).

═══════════════════════════════════════
OUTPUT (SOLO JSON, niente markdown)
═══════════════════════════════════════
{
  "family": "RANGE_CONTROLLATO",
  "analysis": "Breve analisi 2-3 righe: gap U/O, distribuzione 1X2, segnale GG/NG.",
  "playable_markets": [
    {"market": "MG 2-4 totali", "reasoning": "spiegazione 1 riga"},
    {"market": "O1.5", "reasoning": "spiegazione 1 riga"},
    {"market": "DC 1X + U3.5", "reasoning": "spiegazione 1 riga"}
  ],
  "main_prediction": "MG 2-4 totali",
  "confidence": "Media",
  "min_goals": 2,
  "max_goals": 4
}

Mercati ammessi: 1, X, 2, 1X, X2, 12, O1.5, U1.5, O2.5, U2.5, O3.5, U3.5, GG, NG, MG 2-4 totali, MG 2-4 casa, MG 2-4 ospite, DC 1X + U3.5, DC X2 + U3.5, DC 12 + U3.5, DC 1X + O1.5, DC X2 + O1.5, DC 12 + O1.5, GG + O2.5, GG + O1.5."""


LEAGUE_DNA = {
    # Codes ending with key match - based on manifestazione code
    "BUNDES": "Bundesliga (Germania) — DNA Over molto alto (media 3+ gol), difese aperte, ritmi alti",
    "GER1": "Bundesliga — DNA Over alto (3+ gol)",
    "GER2": "2.Bundesliga — DNA Over medio-alto (2.7 gol)",
    "EREDIVISIE": "Eredivisie (Olanda) — DNA Over alto (3+ gol), tante reti",
    "NED1": "Eredivisie — DNA Over alto",
    "MLS": "MLS (USA) — DNA Over alto (2.9 gol)",
    "USA1": "MLS — DNA Over alto",
    "BRA1": "Serie A Brasile — DNA equilibrato (2.5 gol), GG frequente",
    "BRA2": "Serie B Brasile — DNA conservativo (2.2 gol), molti pareggi 0-0/1-1",
    "ARG1": "Liga Argentina — DNA molto conservativa (2.1 gol), tante U2.5",
    "ITA1": "Serie A — DNA medio (2.5 gol), tattiche, U3.5 frequente",
    "ITA2": "Serie B — DNA conservativo (2.3 gol), molti pareggi e under",
    "SPA1": "La Liga — DNA medio-alto (2.6 gol)",
    "SPA2": "Liga 2 — DNA equilibrato (2.4 gol)",
    "ING1": "Premier League — DNA Over alto (2.8 gol), ritmi alti",
    "ING2": "Championship — DNA equilibrato, ritmi alti ma difese deboli",
    "FRA1": "Ligue 1 — DNA medio (2.5 gol)",
    "POR1": "Liga Portuguesa — DNA equilibrato",
    "TUR1": "Süper Lig — DNA Over alto, difese sgangherate",
    "SCO1": "Scottish Premiership — DNA medio-alto",
    "NOR": "Eliteserien (Norvegia) — DNA Over alto",
    "SWE": "Allsvenskan (Svezia) — DNA Over alto",
    "AUS": "A-League — DNA Over",
    "JAP": "J-League — DNA medio (2.5 gol)",
    "KOR": "K-League — DNA equilibrato",
}

CUP_KEYWORDS = ["COPPA", "CUP", "CHAMP", "EUROPA", "CONFERENCE", "LIBERTADORES",
                "SUDAMERICANA", "ASIAN", "CAF", "CONCACAF", "TROPHY", "POKAL",
                "FA ", "EFL", "DFB", "COPPA ITALIA"]


def detect_league_context(manifestazione: str) -> str:
    """Return contextual hints about championship DNA and cup status."""
    if not manifestazione:
        return ""
    code = manifestazione.upper().strip()
    parts = []
    # League DNA
    for key, desc in LEAGUE_DNA.items():
        if key in code:
            parts.append(f"CAMPIONATO: {desc}")
            break
    # Cup detection
    if any(kw in code for kw in CUP_KEYWORDS):
        parts.append("TIPO: PARTITA DI COPPA — tendenza a tatticismi, gestione conservativa nelle fasi a eliminazione, attenzione a supplementari (escludere O3.5 se eliminazione)")
    elif code.endswith("1") or "1" in code[-2:]:
        parts.append("TIPO: Campionato di prima divisione")
    elif code.endswith("2"):
        parts.append("TIPO: Campionato di seconda divisione — solitamente più conservativo, meno gol")
    return " | ".join(parts) if parts else ""


def build_match_prompt(match: dict) -> str:
    context = detect_league_context(match.get('manifestazione', ''))
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
    ctx_block = f"\nCONTESTO CAMPIONATO: {context}\n" if context else ""
    return (
        f"PARTITA: {match['manifestazione']} · {match['time']} "
        f"{match['squadra1']} vs {match['squadra2']}\n"
        f"Quote: {' | '.join(parts)}"
        f"{ctx_block}"
        f"\nUsa il contesto del campionato (DNA gol, partita di coppa) come modulatore: se DNA Over alto privilegia O2.5/O1.5; se DNA conservativo o partita di coppa privilegia U3.5/MG 2-4 e tatticismi.\n"
        f"Analizza e restituisci SOLO JSON."
    )


async def run_ai_prediction(match: dict) -> dict:
    if not EMERGENT_LLM_KEY:
        raise HTTPException(500, "EMERGENT_LLM_KEY not configured")
    chat = LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=f"pred-{match['id']}",
        system_message=PREDICTION_SYSTEM,
    ).with_model("gemini", "gemini-2.5-flash")
    # Build prompt with feedback from market scores (machine learning loop)
    feedback = await get_all_families_stats()
    prompt = build_match_prompt(match)
    if feedback:
        prompt = feedback + "\n\nUSA QUESTO STORICO per aggiustare il ranking: dai priorità a mercati che hanno vinto più volte nella stessa famiglia, e considera anche i mercati con tanti 'persi opportunità' (avrebbero vinto ma non li avevi previsti).\n\n" + prompt
    msg = UserMessage(text=prompt)
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


async def get_all_families_stats() -> str:
    """Build a feedback string from historical scores across all families."""
    docs = await db.market_scores.find({}, {"_id": 0}).sort("total", -1).to_list(200)
    if not docs:
        return ""
    by_family: Dict[str, list] = {}
    for d in docs:
        by_family.setdefault(d["family"], []).append(d)
    blocks = []
    for fam, items in by_family.items():
        lines = [f"STORICO FAMIGLIA {fam}:"]
        for d in items[:8]:
            total = d.get("total", 0)
            wins = d.get("wins", 0)
            missed = d.get("missed_wins", 0)
            rate = (wins / total * 100) if total > 0 else 0
            extra = f" | persi opportunità {missed}" if missed else ""
            lines.append(f"  - {d['market']}: {wins}W/{total} ({rate:.0f}%){extra}")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


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
async def predict_match(match_id: str, force: bool = False):
    match = await db.matches.find_one({'id': match_id}, {'_id': 0})
    if not match:
        raise HTTPException(404, "Match not found")
    if force:
        await db.predictions.delete_many({'match_id': match_id})
    else:
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
    match = await db.matches.find_one({'id': match_id}, {'_id': 0})
    if not match:
        raise HTTPException(404, "Match not found")
    parsed = parse_result(body.result)
    if not parsed:
        raise HTTPException(400, "Formato risultato non valido (es. 2-1)")
    home, away = parsed
    await db.matches.update_one(
        {'id': match_id},
        {'$set': {'result': body.result, 'updated_at': datetime.now(timezone.utc).isoformat()}},
    )
    prediction = await db.predictions.find_one({'match_id': match_id}, {'_id': 0})
    learning = {"applied": False}
    if prediction:
        await update_market_scores(match, prediction, home, away)
        # Compute hit/miss summary for response
        main_pred = prediction.get("main_prediction")
        if main_pred:
            outcome = evaluate_market(main_pred, home, away)
            learning = {
                "applied": True,
                "main_prediction": main_pred,
                "result_ok": outcome,
            }
    return {"ok": True, "learning": learning}


@api_router.post("/results/bulk")
async def bulk_results(body: BulkResult):
    count = 0
    learnings = []
    for item in body.items:
        if 'id' not in item or 'result' not in item:
            continue
        match = await db.matches.find_one({'id': item['id']}, {'_id': 0})
        if not match:
            continue
        parsed = parse_result(item['result'])
        if not parsed:
            continue
        home, away = parsed
        await db.matches.update_one(
            {'id': item['id']},
            {'$set': {'result': item['result'], 'updated_at': datetime.now(timezone.utc).isoformat()}},
        )
        count += 1
        prediction = await db.predictions.find_one({'match_id': item['id']}, {'_id': 0})
        if prediction:
            await update_market_scores(match, prediction, home, away)
            main_pred = prediction.get("main_prediction")
            if main_pred:
                learnings.append({
                    "match_id": item['id'],
                    "main_prediction": main_pred,
                    "result_ok": evaluate_market(main_pred, home, away),
                })
    return {"updated": count, "learnings": learnings}


@api_router.get("/stats/scores")
async def stats_scores():
    docs = await db.market_scores.find({}, {'_id': 0}).to_list(500)
    by_family: Dict[str, list] = {}
    for d in docs:
        d["win_rate"] = round((d.get("wins", 0) / d.get("total", 1)) * 100, 1) if d.get("total", 0) > 0 else 0
        by_family.setdefault(d["family"], []).append(d)
    for fam in by_family:
        by_family[fam].sort(key=lambda x: (-x.get("win_rate", 0), -x.get("total", 0)))
    return by_family


@api_router.post("/stats/reset")
async def stats_reset():
    await db.market_scores.delete_many({})
    return {"ok": True}


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
        return {"csv": "", "count": 0}
    csv_lines = ["Ora,Lega,Casa,Ospite,1,X,2,1X,X2,U1.5,O1.5,U2.5,O2.5,U3.5,O3.5,GG,NG"]
    for m in selected:
        o = m.get('odds', {})
        def v(k):
            x = o.get(k)
            return "" if x is None else str(x)
        # Sanitize commas in team / league names
        def s(x): return str(x).replace(',', ' ').strip()
        csv_lines.append(",".join([
            m['time'], s(m['manifestazione']), s(m['squadra1']), s(m['squadra2']),
            v('odd_1'), v('odd_X'), v('odd_2'),
            v('odd_1X'), v('odd_X2'),
            v('odd_U15'), v('odd_O15'),
            v('odd_U25'), v('odd_O25'),
            v('odd_U35'), v('odd_O35'),
            v('odd_GG'), v('odd_NG'),
        ]))
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

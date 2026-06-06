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
import asyncio
from difflib import SequenceMatcher
from pathlib import Path
from datetime import datetime, date, timedelta, timezone
from typing import List, Optional, Dict, Any

import httpx
import pandas as pd
from pydantic import BaseModel, Field

from emergentintegrations.llm.chat import LlmChat, UserMessage


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

EMERGENT_LLM_KEY = os.environ.get('EMERGENT_LLM_KEY', '')
DEEPSEEK_API_KEY = os.environ.get('DEEPSEEK_API_KEY', '')

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
    """Update per-family market scores based on actual result vs predicted markets.
    Tracks GLOBAL aggregate + PER-LEAGUE breakdown + family match counter."""
    family = prediction.get("family", "INSTABILE")
    manif = match.get("manifestazione", "")
    playable = prediction.get("playable_markets") or []
    markets_to_update = [m.get("market") for m in playable if m.get("market")]
    if prediction.get("main_prediction") and prediction["main_prediction"] not in markets_to_update:
        markets_to_update.insert(0, prediction["main_prediction"])

    # Increment family match counter (used for miss_rate denominator)
    await db.family_counters.update_one(
        {"family": family},
        {"$inc": {"matches": 1}},
        upsert=True,
    )
    if manif:
        await db.family_counters.update_one(
            {"family": family, "league": manif},
            {"$inc": {"matches": 1}},
            upsert=True,
        )

    for market in markets_to_update:
        outcome = evaluate_market(market, home, away)
        if outcome is None:
            continue
        inc = {("wins" if outcome else "losses"): 1, "total": 1}
        # Global (no league key)
        await db.market_scores.update_one(
            {"family": family, "market": market, "league": None},
            {"$inc": inc},
            upsert=True,
        )
        # Per-league
        if manif:
            await db.market_scores.update_one(
                {"family": family, "market": market, "league": manif},
                {"$inc": inc},
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
                {"family": family, "market": market, "league": None},
                {"$inc": {"missed_wins": 1}},
                upsert=True,
            )
            if manif:
                await db.market_scores.update_one(
                    {"family": family, "market": market, "league": manif},
                    {"$inc": {"missed_wins": 1}},
                    upsert=True,
                )


async def get_family_stats(family: str, league: Optional[str] = None) -> str:
    """Build a feedback string from historical scores for this family.
    Includes BOTH global and per-league win rates so the AI knows context.
    """
    # Global (league=None)
    global_docs = await db.market_scores.find({"family": family, "league": None}, {"_id": 0}).to_list(100)
    league_docs = await db.market_scores.find({"family": family, "league": league}, {"_id": 0}).to_list(100) if league else []

    def fmt_docs(docs, prefix=""):
        lines = []
        for d in docs:
            total = d.get("total", 0)
            wins = d.get("wins", 0)
            missed = d.get("missed_wins", 0)
            if total == 0 and missed == 0:
                continue
            rate = (wins / total * 100) if total > 0 else 0
            extras = []
            if missed:
                extras.append(f"persi {missed}")
            extra_txt = f" | {' '.join(extras)}" if extras else ""
            lines.append(f"  - {d['market']}: {wins}/{total} ({rate:.0f}%){extra_txt}")
        return lines

    parts = []
    glines = fmt_docs(global_docs)
    if glines:
        parts.append(f"STORICO GLOBALE FAMIGLIA {family}:\n" + "\n".join(glines))
    llines = fmt_docs(league_docs)
    if llines and league:
        parts.append(f"\nSTORICO SPECIFICO {league}:\n" + "\n".join(llines))
    return "\n".join(parts) if parts else ""


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
FASE 3 — RANKING + PAVIMENTO/TETTO ESPLICITI
═══════════════════════════════════════
Restituisci 3-5 mercati ordinati dal PIÙ PROBABILE al MENO PROBABILE.
Il "main_prediction" è il primo (più probabile).

OBBLIGO: il campo "analysis" DEVE iniziare SEMPRE con la SINTESI A SISTEMA:
  "PAVIMENTO: X gol | TETTO: Y gol | RANGE: X-Y gol"
poi 2-3 righe di motivazione che leggono le quote come SISTEMA (non singole),
indicando gap rilevanti e segnali strutturali.

Come stabilire PAVIMENTO e TETTO:
- PAVIMENTO = gol minimo probabili. Es. O1.5 ≤ 1.30 ⇒ pavimento 2. O1.5 1.31-1.60 ⇒ pavimento "0 (probabile 2)". O1.5 > 1.60 ⇒ pavimento 0.
- TETTO = gol massimo probabili. Es. U3.5 ≤ 1.40 ⇒ tetto 3. U2.5 ≤ 1.40 ⇒ tetto 2. U3.5 > 1.85 ⇒ tetto "aperto".
- Quando trovi gap forte O/U (es. U3.5 1.30 vs O3.5 3.20) usalo come segnale di tetto chiaro.
- I mercati 1, 2, X, 1X, X2 NON DEVONO essere usati se la quota corrispondente è > 1.85 (regola assoluta).
- Verifica COERENZA tra mercati scelti: NO mix discordante (GG con NG, O2.5 con U2.5, 1 con X2).

═══════════════════════════════════════
OUTPUT (SOLO JSON, niente markdown)
═══════════════════════════════════════
{
  "family": "RANGE_CONTROLLATO",
  "analysis": "PAVIMENTO: 2 gol | TETTO: 4 gol | RANGE: 2-4 gol. Quote O1.5 1.30 + U3.5 1.40 → range chiuso. Gap GG 1.85 vs NG 1.95 ⇒ partita simmetrica.",
  "playable_markets": [
    {"market": "MG 2-4 totali", "reasoning": "Pavimento 2, tetto 4: copertura range completo"},
    {"market": "O1.5", "reasoning": "Pavimento 2 con quota convenientemente sicura"},
    {"market": "DC 1X + U3.5", "reasoning": "Pavimento qualsiasi + tetto 3, copertura difensiva"}
  ],
  "main_prediction": "MG 2-4 totali",
  "confidence": "Media",
  "min_goals": 2,
  "max_goals": 4
}

Mercati ammessi: 1, X, 2, 1X, X2, 12, O1.5, U1.5, O2.5, U2.5, O3.5, U3.5, GG, NG, MG 2-4 totali, MG 2-4 casa, MG 2-4 ospite, DC 1X + U3.5, DC X2 + U3.5, DC 12 + U3.5, DC 1X + O1.5, DC X2 + O1.5, DC 12 + O1.5, GG + O2.5."""


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


# ============================================================
# LEAGUE CODE PARSER (Python equivalent of frontend/src/utils/leagues.ts)
# ============================================================

LEAGUE_COUNTRY_CODES = {
    "AFG": "Afghanistan", "ALB": "Albania", "ALG": "Algeria", "AND": "Andorra",
    "ANG": "Angola", "ARA": "Arabia Saudita", "ARG": "Argentina", "ARM": "Armenia",
    "AUS": "Australia", "AUT": "Austria", "AZE": "Azerbaigian", "BEL": "Belgio",
    "BOL": "Bolivia", "BRA": "Brasile", "BUL": "Bulgaria", "CAM": "Camerun",
    "CAN": "Canada", "CHI": "Cile", "CIN": "Cina", "COL": "Colombia",
    "COR": "Corea del Sud", "COS": "Costa Rica", "CRO": "Croazia", "DAN": "Danimarca",
    "ECU": "Ecuador", "EGI": "Egitto", "ESA": "El Salvador", "EST": "Estonia",
    "FIL": "Filippine", "FIN": "Finlandia", "FRA": "Francia", "GAL": "Galles", "GEO": "Georgia",
    "GER": "Germania", "GHA": "Ghana", "GIA": "Giappone", "GIO": "Giordania",
    "GRE": "Grecia", "GUA": "Guatemala", "GUI": "Guinea", "HON": "Honduras",
    "IND": "India", "ING": "Inghilterra", "IRA": "Iran", "IRL": "Irlanda",
    "ISL": "Islanda", "ISR": "Israele", "ITA": "Italia", "KAZ": "Kazakistan",
    "KEN": "Kenya", "LET": "Lettonia", "LIT": "Lituania", "LUX": "Lussemburgo",
    "MAR": "Marocco", "MEX": "Messico", "MOL": "Moldavia", "MON": "Montenegro",
    "NIG": "Nigeria", "NOR": "Norvegia", "NUA": "Nuova Zelanda", "OLA": "Olanda",
    "PAN": "Panama", "PAR": "Paraguay", "PER": "Perù", "POL": "Polonia",
    "POR": "Portogallo", "QAT": "Qatar", "REP": "Repubblica Ceca", "ROM": "Romania",
    "RUS": "Russia", "SCO": "Scozia", "SEN": "Senegal", "SER": "Serbia",
    "SIN": "Singapore", "SLO": "Slovenia", "SPA": "Spagna", "SRI": "Sri Lanka",
    "SUD": "Sudafrica", "SUR": "Suriname", "SVE": "Svezia", "SVI": "Svizzera",
    "TAG": "Tagikistan", "TAI": "Thailandia", "TUN": "Tunisia", "TUR": "Turchia",
    "UCR": "Ucraina", "UNG": "Ungheria", "URU": "Uruguay", "USA": "Stati Uniti",
    "UZB": "Uzbekistan", "VEN": "Venezuela", "VIE": "Vietnam",
}

LEAGUE_CATEGORY = {
    "1": "Prima Lega", "2": "Seconda Lega", "3": "Terza Lega",
    "4": "Quarta Lega", "5": "Quinta Lega", "6": "Sesta Lega",
    "F": "Femminile", "U17": "Under 17", "U19": "Under 19",
    "U20": "Under 20", "U21": "Under 21", "U23": "Under 23",
    "CP": "Coppa", "CUP": "Coppa", "RS": "Riserve",
    "CH": "Champions League", "EU": "Europa League", "CONF": "Conference League",
}

LEAGUE_SPECIAL = [
    (re.compile(r"^AMIU(\d{2})"), lambda m: f"Amichevole Under {m.group(1)}"),
    (re.compile(r"^AMINAZ"), lambda m: "Amichevole Nazionali"),
    (re.compile(r"^AMICLUB"), lambda m: "Amichevole Club"),
    (re.compile(r"^AMIF"), lambda m: "Amichevole Femminile"),
    (re.compile(r"^AMI"), lambda m: "Amichevole"),
    (re.compile(r"^EUCONFL"), lambda m: "Euro Conference League"),
    (re.compile(r"^CPSUDAM"), lambda m: "Coppa Sudamerica"),
    (re.compile(r"^CPLIB"), lambda m: "Coppa Libertadores"),
    (re.compile(r"^CPCAR"), lambda m: "Coppa Caraibica"),
    (re.compile(r"^CONCAF"), lambda m: "Concacaf"),
    (re.compile(r"^CHAM"), lambda m: "Champions League"),
    (re.compile(r"^EUR(?!O)"), lambda m: "Europa League"),
    (re.compile(r"^CONF"), lambda m: "Conference League"),
    (re.compile(r"^MOND"), lambda m: "Mondiali"),
]


def parse_league_label(code: str) -> str:
    """Return a human-readable competition label like 'Italia Prima Lega' or 'Australia Coppa'."""
    if not code:
        return ""
    c = code.strip().upper()
    # Special tournaments
    for pat, builder in LEAGUE_SPECIAL:
        m = pat.match(c)
        if m:
            return builder(m)
    # Country prefix
    for prefix, name in LEAGUE_COUNTRY_CODES.items():
        if c.startswith(prefix):
            parts = [name]
            rest = c[len(prefix):]
            # Special case: if "CP" appears anywhere in the rest → Coppa
            # Examples: AUSQCP → Australia Coppa, ECUCP → Ecuador Coppa
            if "CP" in rest:
                parts.append("Coppa")
                if rest.endswith("F"):
                    parts.append("Femminile")
                if rest.endswith("RS"):
                    parts.append("Riserve")
                return " ".join(parts)
            # Letter category first (U19, F, CP, CUP, RS, CH, EU, CONF)
            cat_match = re.match(r"^(U\d{2}|F|CP|CUP|RS|CH|EU|CONF)", rest)
            if cat_match:
                parts.append(LEAGUE_CATEGORY.get(cat_match.group(1), cat_match.group(1)))
            else:
                num_match = re.match(r"^(\d+)", rest)
                if num_match:
                    n = num_match.group(1)
                    parts.append(LEAGUE_CATEGORY.get(n, f"Serie {n}"))
                    tail = rest[len(n):]
                    if tail and tail in LEAGUE_CATEGORY:
                        parts.append(LEAGUE_CATEGORY[tail])
            return " ".join(parts)
    return ""


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
    manif = match.get('manifestazione', '')
    context = detect_league_context(manif)
    parsed_comp = parse_league_label(manif)
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
    comp_line = f" ({parsed_comp})" if parsed_comp else ""
    return (
        f"PARTITA: {manif}{comp_line} · {match['time']} "
        f"{match['squadra1']} vs {match['squadra2']}\n"
        f"Quote: {' | '.join(parts)}"
        f"{ctx_block}"
        f"\nUsa il contesto del campionato (DNA gol, partita di coppa) come modulatore: se DNA Over alto privilegia O2.5/O1.5; se DNA conservativo o partita di coppa privilegia U3.5/MG 2-4 e tatticismi.\n"
        f"Analizza e restituisci SOLO JSON."
    )


# ============================================================
# SETTINGS & LLM SELECTOR
# ============================================================

LLM_OPTIONS = [
    {"id": "deepseek-chat", "label": "DeepSeek V4 Lite", "provider": "deepseek", "model": "deepseek-chat",
     "cost_per_pred": 0.0014, "speed": "Veloce", "quality": "Buono", "desc": "Economicissimo (~€1,56/mese per 40 pred/giorno)"},
    {"id": "deepseek-reasoner", "label": "DeepSeek V4 Pro", "provider": "deepseek", "model": "deepseek-reasoner",
     "cost_per_pred": 0.0027, "speed": "Lento", "quality": "Ottimo", "desc": "Ragionamento profondo, costo ridotto (~€3/mese)"},
    {"id": "gemini-flash", "label": "Gemini 2.5 Flash", "provider": "gemini", "model": "gemini-2.5-flash",
     "cost_per_pred": 0.002, "speed": "Veloce", "quality": "Buono", "desc": "Veloce e bilanciato"},
    {"id": "gemini-pro", "label": "Gemini 2.5 Pro", "provider": "gemini", "model": "gemini-2.5-pro",
     "cost_per_pred": 0.025, "speed": "Medio", "quality": "Ottimo", "desc": "Ragionamento più profondo"},
    {"id": "claude-haiku", "label": "Claude Haiku 4.5", "provider": "anthropic", "model": "claude-haiku-4-5-20251001",
     "cost_per_pred": 0.005, "speed": "Veloce", "quality": "Buono", "desc": "Bilanciato economia/qualità"},
    {"id": "claude-sonnet", "label": "Claude Sonnet 4.5", "provider": "anthropic", "model": "claude-sonnet-4-5-20250929",
     "cost_per_pred": 0.016, "speed": "Medio", "quality": "Eccellente", "desc": "Top ragionamento, più costoso"},
    {"id": "gpt-4o-mini", "label": "GPT-4o Mini", "provider": "openai", "model": "gpt-4o-mini",
     "cost_per_pred": 0.003, "speed": "Veloce", "quality": "Buono", "desc": "Veloce e ben bilanciato"},
    {"id": "gpt-4o", "label": "GPT-4o", "provider": "openai", "model": "gpt-4o",
     "cost_per_pred": 0.020, "speed": "Medio", "quality": "Ottimo", "desc": "Eccellente per analisi complesse"},
]

DEFAULT_LLM = "deepseek-chat"


async def get_selected_llm() -> dict:
    doc = await db.settings.find_one({"key": "llm_model"}, {"_id": 0})
    llm_id = (doc or {}).get("value", DEFAULT_LLM)
    for o in LLM_OPTIONS:
        if o["id"] == llm_id:
            return o
    return LLM_OPTIONS[0]


@api_router.get("/settings/llm")
async def get_llm_settings():
    selected = await get_selected_llm()
    return {"options": LLM_OPTIONS, "selected_id": selected["id"]}


@api_router.post("/settings/llm")
async def set_llm_settings(payload: Dict[str, Any]):
    llm_id = payload.get("id")
    if not any(o["id"] == llm_id for o in LLM_OPTIONS):
        raise HTTPException(400, "LLM id non valido")
    await db.settings.update_one(
        {"key": "llm_model"},
        {"$set": {"key": "llm_model", "value": llm_id}},
        upsert=True,
    )
    return {"ok": True, "selected_id": llm_id}


@api_router.get("/settings/budget")
async def get_budget_info():
    """Aggregate estimated cost from local counter."""
    doc = await db.settings.find_one({"key": "ai_spent"}, {"_id": 0})
    spent = (doc or {}).get("value", 0.0)
    selected = await get_selected_llm()
    pred_count_doc = await db.settings.find_one({"key": "ai_count"}, {"_id": 0})
    count = (pred_count_doc or {}).get("value", 0)
    return {
        "estimated_spent_usd": round(spent, 4),
        "predictions_made": count,
        "current_model": selected["label"],
        "cost_per_prediction_usd": selected["cost_per_pred"],
        "topup_url": "https://app.emergent.sh/chat",
    }


@api_router.post("/settings/budget/reset")
async def reset_budget():
    await db.settings.update_one({"key": "ai_spent"}, {"$set": {"value": 0.0}}, upsert=True)
    await db.settings.update_one({"key": "ai_count"}, {"$set": {"value": 0}}, upsert=True)
    return {"ok": True}


async def run_ai_prediction(match: dict) -> dict:
    if not EMERGENT_LLM_KEY and not DEEPSEEK_API_KEY:
        raise HTTPException(500, "Nessuna API key configurata")
    llm = await get_selected_llm()
    # Build prompt with feedback from market scores (machine learning loop)
    feedback = await get_all_families_stats(match.get('manifestazione'))
    prompt = build_match_prompt(match)
    if feedback:
        prompt = feedback + "\n\nUSA QUESTO STORICO per aggiustare il ranking: dai priorità a mercati che hanno vinto più volte nella stessa famiglia, e considera anche i mercati con tanti 'persi opportunità' (avrebbero vinto ma non li avevi previsti).\n\n" + prompt

    # ============================================================
    # PIN STRUTTURALE: forza l'AI a usare il NOSTRO floor/ceiling
    # ============================================================
    # DeepSeek calcola floor/ceiling con regole proprie incoerenti.
    # Il nostro motore Poisson + borderline buffer è MATEMATICAMENTE
    # superiore (vedi caso Slovacchia 2-2 dove AI diceva ceiling=3
    # ma il nostro sistema correttamente diceva 4).
    #
    # Iniettiamo i valori autoritari del cluster_engine così che
    # l'AI li usi come INPUT FISSO invece di calcolarli male.
    # ============================================================
    try:
        from cluster_engine import structural_analysis
        odds = match.get("odds") or {}
        if odds:
            sa = structural_analysis(odds)
            s = sa.get("structure", {})
            sfloor = s.get("goal_floor", 0)
            sceiling = s.get("goal_ceiling", 7)
            sopen = s.get("goal_ceiling_open", False)
            sfam = s.get("family", "?")
            ceiling_str = "APERTO (no max)" if sopen else str(sceiling)
            range_str = s.get("goal_range", f"{sfloor}-{ceiling_str}")
            pin = f"""\n\n============================================================
🔒 PIN STRUTTURALE (calcolato dal Motore Poisson — usa QUESTI valori, NON ricalcolarli):
============================================================
- PAVIMENTO: {sfloor} gol minimi attesi
- TETTO: {ceiling_str} gol massimi attesi
- RANGE: {range_str}
- FAMIGLIA STRUTTURALE: {sfam}
- λ Poisson Casa: {s.get('lambda_home', 0):.2f}
- λ Poisson Ospite: {s.get('lambda_away', 0):.2f}

REGOLE OBBLIGATORIE basate sul PIN:
1. Il "PAVIMENTO" e "TETTO" sopra sono CALCOLATI MATEMATICAMENTE con
   "borderline buffer" (zona incerta → step verso sicurezza). USALI ESATTAMENTE.
2. NON proporre mercati incoerenti col PIN:
   - Se PAVIMENTO=0 → NON proporre MG che inizia da 2+ (es. "MG 2-4 totali" VIETATO)
   - Se TETTO=APERTO → NON proporre U2.5 / U3.5 / "MG 2-4" (range chiuso VIETATO)
   - Se TETTO=4 e PAVIMENTO=2 → NON proporre "MG 1-3" (lo=1≠2 VIETATO)
   - MG range valido: lo ≤ pavimento+1 AND (aperto: hi≥6 ; chiuso: hi≥tetto)
3. Nel campo "analysis" devi SCRIVERE LETTERALMENTE: "PAVIMENTO: {sfloor} gol | TETTO: {ceiling_str} gol | RANGE: {range_str}"
4. Nei "playable_markets" PROPONI SOLO mercati coerenti con questo PIN.
============================================================\n"""
            prompt = prompt + pin
    except Exception as e:
        print(f"[PIN structural injection failed]: {e}")

    if llm["provider"] == "deepseek":
        # Direct LiteLLM call bypassing Emergent proxy
        if not DEEPSEEK_API_KEY:
            raise HTTPException(500, "DEEPSEEK_API_KEY not configured")
        import litellm
        # Reasoner model needs much higher token limit (thinking tokens consumed)
        max_tok = 8000 if "reasoner" in llm["model"] else 2000
        try:
            resp = await litellm.acompletion(
                model=f"deepseek/{llm['model']}",
                api_key=DEEPSEEK_API_KEY,
                messages=[
                    {"role": "system", "content": PREDICTION_SYSTEM},
                    {"role": "user", "content": prompt + "\n\nIMPORTANTE: rispondi SOLO con il JSON, niente testo introduttivo, niente ragionamento, solo l'oggetto JSON."},
                ],
                temperature=0.2,  # bassa stocasticità: lieve variazione, ragionamento coerente
                max_tokens=max_tok,
            )
            msg = resp["choices"][0]["message"]
            text = msg.get("content") or msg.get("reasoning_content") or ""
            # If reasoner returned content blank but reasoning has JSON, use reasoning
            if not text.strip() and msg.get("reasoning_content"):
                text = msg["reasoning_content"]
        except Exception as e:
            raise HTTPException(500, f"DeepSeek error: {e}")
    else:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"pred-{match['id']}",
            system_message=PREDICTION_SYSTEM,
        ).with_model(llm["provider"], llm["model"])
        msg = UserMessage(text=prompt)
        response = await chat.send_message(msg)
        text = response if isinstance(response, str) else str(response)
    # Track estimated cost
    try:
        await db.settings.update_one({"key": "ai_spent"}, {"$inc": {"value": llm["cost_per_pred"]}}, upsert=True)
        await db.settings.update_one({"key": "ai_count"}, {"$inc": {"value": 1}}, upsert=True)
    except Exception:
        pass
    return parse_ai_json(text)


def parse_ai_json(text: str) -> dict:
    """Robust JSON extraction. Handles reasoning preambles, markdown fences, etc."""
    if not text:
        return {"family": "INSTABILE", "analysis": "Risposta vuota", "playable_markets": [],
                "main_prediction": None, "confidence": "Bassa"}
    # 1) Try markdown fenced JSON ```json ... ```
    fence = re.search(r'```(?:json)?\s*(\{[\s\S]*?\})\s*```', text, re.IGNORECASE)
    candidates = []
    if fence:
        candidates.append(fence.group(1))
    # 2) Find all balanced JSON objects (greedy from each `{`)
    starts = [i for i, c in enumerate(text) if c == '{']
    for s in starts:
        depth = 0
        for i in range(s, len(text)):
            if text[i] == '{':
                depth += 1
            elif text[i] == '}':
                depth -= 1
                if depth == 0:
                    candidates.append(text[s:i+1])
                    break
    # Try parsing from longest to shortest (most likely the full payload)
    candidates.sort(key=len, reverse=True)
    for c in candidates:
        try:
            obj = json.loads(c)
            if isinstance(obj, dict) and "family" in obj:
                return obj
        except json.JSONDecodeError:
            continue
    # Fallback
    return {"family": "INSTABILE", "analysis": text[:300], "playable_markets": [],
            "main_prediction": None, "confidence": "Bassa"}


async def get_all_families_stats(league: Optional[str] = None) -> str:
    """Build a feedback string from historical scores across all families.
    If league is given, include BOTH global aggregates and the league-specific section.
    """
    # Filter global docs (no league key)
    docs = await db.market_scores.find({"league": None}, {"_id": 0}).sort("total", -1).to_list(200)
    if not docs and not league:
        return ""

    def render_block(items, title):
        lines = [title]
        for d in items[:8]:
            total = d.get("total", 0)
            wins = d.get("wins", 0)
            missed = d.get("missed_wins", 0)
            if total == 0 and missed == 0:
                continue
            rate = (wins / total * 100) if total > 0 else 0
            extra = f" | persi {missed}" if missed else ""
            lines.append(f"  - {d['market']}: {wins}W/{total} ({rate:.0f}%){extra}")
        return "\n".join(lines) if len(lines) > 1 else ""

    blocks = []
    by_family: Dict[str, list] = {}
    for d in docs:
        by_family.setdefault(d["family"], []).append(d)
    for fam, items in by_family.items():
        b = render_block(items, f"STORICO GLOBALE {fam}:")
        if b:
            blocks.append(b)

    # Per-league section
    if league:
        league_docs = await db.market_scores.find({"league": league}, {"_id": 0}).sort("total", -1).to_list(200)
        if league_docs:
            by_lf: Dict[str, list] = {}
            for d in league_docs:
                by_lf.setdefault(d["family"], []).append(d)
            for fam, items in by_lf.items():
                b = render_block(items, f"STORICO {league} {fam}:")
                if b:
                    blocks.append(b)

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
            'playable_markets': result.get('playable_markets', []),
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
    """Return GLOBAL (league=null) market scores grouped by family."""
    docs = await db.market_scores.find(
        {"$or": [{"league": None}, {"league": {"$exists": False}}]},
        {'_id': 0}
    ).to_list(500)
    by_family: Dict[str, list] = {}
    for d in docs:
        d["win_rate"] = round((d.get("wins", 0) / d.get("total", 1)) * 100, 1) if d.get("total", 0) > 0 else 0
        by_family.setdefault(d["family"], []).append(d)
    for fam in by_family:
        by_family[fam].sort(key=lambda x: (-x.get("win_rate", 0), -x.get("total", 0)))
    return by_family


@api_router.get("/ml/stats")
async def ml_stats():
    """Return flat list of GLOBAL market scores + family counters."""
    # Match both legacy docs (no `league` field) and new docs with league=None
    docs = await db.market_scores.find(
        {"$or": [{"league": None}, {"league": {"$exists": False}}]},
        {'_id': 0}
    ).to_list(500)
    counters = await db.family_counters.find(
        {"$or": [{"league": None}, {"league": {"$exists": False}}]},
        {'_id': 0}
    ).to_list(50)
    family_totals = {c.get("family"): c.get("matches", 0) for c in counters}

    out = []
    for d in docs:
        total = d.get("total", 0)
        missed = d.get("missed_wins", 0)
        wins = d.get("wins", 0)
        family = d.get("family", "")
        if total == 0 and missed == 0:
            continue
        ft = family_totals.get(family, 0)
        out.append({
            "family": family,
            "market": d.get("market", ""),
            "wins": wins,
            "losses": max(0, total - wins),
            "total": total,
            "missed": missed,
            "family_total": ft,
            "miss_rate": round((missed / ft) * 100, 1) if ft > 0 else 0.0,
            "win_rate": round((wins / total) * 100, 1) if total > 0 else 0.0,
        })
    out.sort(key=lambda x: (-x["total"], -x["win_rate"]))
    return {"markets": out, "family_totals": family_totals}


from cluster_engine import structural_analysis


@api_router.get("/match/{match_id}/structural")
async def match_structural(match_id: str):
    """Full structural analysis: family, cluster, market ranking with coverage/fragility.
    Applica ML BOOST CONSERVATIVO basato sullo storico empirico della famiglia
    (≥10 valutazioni richieste, +/-10% massimo per mercato).
    """
    m = await db.matches.find_one({"id": match_id}, {"_id": 0})
    if not m:
        raise HTTPException(404, "match not found")
    odds = m.get("odds") or {}

    # ============================================================
    # Carica ml_scores per la famiglia dalla AI-classification.
    # Le famiglie del motore strutturale (DOMINANZA_CHIUSA, EQUILIBRATA_*, ecc.)
    # NON sempre coincidono con quelle dell'AI prompt (OFFENSIVA_PULITA,
    # RANGE_CONTROLLATO, ecc.). Per non disperdere lo storico, tentiamo PRIMA
    # la famiglia AI già stabilita nel pronostico salvato; poi facciamo
    # fallback alla famiglia del motore. Se entrambe sono vuote, ml=None.
    # ============================================================
    from cluster_engine import classify_family
    cluster_family = classify_family(odds).get("family")
    pred_family = (m.get("prediction") or {}).get("family") or m.get("family")
    # Mapping euristico: famiglie del motore strutturale → famiglie AI prompt
    # (per riusare lo storico anche se i nomi divergono leggermente)
    cluster_to_ai = {
        "EQUILIBRATA_OFFENSIVA": "OFFENSIVA_PULITA",
        "EQUILIBRATA_CHIUSA": "CHIUSA_PROTETTA",
        "DOMINANZA_CHIUSA": "DOMINANZA_CON_TETTO",
        "DOMINANZA_OVER": "OFFENSIVA_PULITA",
        "BLOCCATA": "RANGE_CONTROLLATO",
    }
    mapped_family = cluster_to_ai.get(cluster_family or "")
    # Priorità: famiglia salvata > famiglia cluster_engine > mapping euristico
    candidate_families = [pred_family, cluster_family, mapped_family]
    ml_scores: Dict[str, Dict] = {}
    matched_family: Optional[str] = None
    for fam in candidate_families:
        if not fam:
            continue
        docs = await db.market_scores.find(
            {"family": fam, "$or": [{"league": None}, {"league": {"$exists": False}}]},
            {"_id": 0}
        ).to_list(100)
        if docs:
            for d in docs:
                total = d.get("total", 0)
                wins = d.get("wins", 0)
                wr = (wins / total * 100.0) if total > 0 else 0.0
                ml_scores[d["market"]] = {
                    "win_rate": round(wr, 1),
                    "total": total,
                    "wins": wins,
                    "losses": max(0, total - wins),
                }
            matched_family = fam
            break  # use first family that has data
    result = structural_analysis(odds, ml_scores=ml_scores or None)
    # Espone meta-info per debug/UI: quale famiglia ha alimentato il ML boost
    result["ml_source_family"] = matched_family
    return result


@api_router.post("/predict/structural")
async def predict_structural_from_odds(body: dict):
    """Compute structural analysis from raw odds (for testing without DB match)."""
    return structural_analysis(body.get("odds") or body)


@api_router.post("/ml/backfill")
async def ml_backfill():
    """Backfill family_counters from existing matches with results+predictions.
    Useful one-shot after schema migrations.
    """
    cursor = db.matches.find(
        {"result": {"$nin": [None, ""]}},
        {"_id": 0, "prediction": 1, "family": 1, "main_prediction": 1, "manifestazione": 1, "result": 1}
    )
    family_counts: Dict[str, int] = {}
    family_league_counts: Dict[str, int] = {}
    async for m in cursor:
        # Family may be in either `prediction.family` (new schema) or top-level `family` (legacy)
        fam = (m.get("prediction") or {}).get("family") or m.get("family")
        if not fam:
            continue
        family_counts[fam] = family_counts.get(fam, 0) + 1
        league = m.get("manifestazione")
        if league:
            key = f"{fam}||{league}"
            family_league_counts[key] = family_league_counts.get(key, 0) + 1

    # Reset and write
    await db.family_counters.delete_many({})
    for fam, count in family_counts.items():
        await db.family_counters.update_one(
            {"family": fam, "league": None},
            {"$set": {"matches": count}},
            upsert=True,
        )
    for key, count in family_league_counts.items():
        fam, league = key.split("||", 1)
        await db.family_counters.update_one(
            {"family": fam, "league": league},
            {"$set": {"matches": count}},
            upsert=True,
        )
    return {"ok": True, "families": family_counts, "league_keys": len(family_league_counts)}


@api_router.post("/stats/reset")
async def stats_reset():
    await db.market_scores.delete_many({})
    await db.family_counters.delete_many({})
    return {"ok": True}


# ============================================================
# SOFASCORE AUTO-FETCH RESULTS
# ============================================================

SOFASCORE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
    "Referer": "https://www.sofascore.com/",
    "Origin": "https://www.sofascore.com",
    "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
}


def _name_similarity(a: str, b: str) -> float:
    """Return 0-1 similarity between two team names (case/diacritic insensitive)."""
    if not a or not b:
        return 0.0
    def norm(s: str) -> str:
        s = s.lower().strip()
        # Strip common suffixes
        for suf in [" fc", " sc", " cf", " rj", " sp", " mg", " ba", " ca", " ec", " ud", " ad", " club"]:
            if s.endswith(suf):
                s = s[: -len(suf)]
        # Remove punctuation
        s = re.sub(r"[^\w\s]", "", s)
        s = re.sub(r"\s+", " ", s)
        return s.strip()
    return SequenceMatcher(None, norm(a), norm(b)).ratio()


async def _fetch_fotmob_match(http: httpx.AsyncClient, home: str, away: str, day: str) -> dict:
    """Fallback search via Fotmob's match-suggest API. Useful for exotic competitions
    (Coppa Libertadores, Sudamericana, etc.) often missing from TheSportsDB.
    """
    try:
        # Fotmob exposes a suggest endpoint that returns matches matching a free-text query.
        # Note: requires browser-like headers and accepts most pairings.
        url = f"https://www.fotmob.com/api/searchapi/suggest?term={home.replace(' ', '+')}"
        r = await http.get(url, timeout=12.0, headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            "Accept": "application/json",
        })
        if r.status_code != 200:
            return {"found": False, "reason": f"fotmob {r.status_code}"}
        # The API may return a single JSON object or several "result groups" — defensive parsing
        data = r.json()
    except Exception as e:
        return {"found": False, "reason": f"fotmob err: {e}"}

    # Walk through groups → matches; Fotmob returns suggest sections with teamSuggest / matchSuggest
    candidates: list = []
    if isinstance(data, dict):
        for group in (data.get("suggests") or data.get("suggestions") or [data]):
            options = group.get("options") if isinstance(group, dict) else None
            if not options:
                continue
            for opt in options:
                payload = opt.get("payload") or opt
                # We want match-type results
                if isinstance(payload, dict):
                    candidates.append(payload)
    if not candidates:
        return {"found": False, "reason": "no fotmob candidates"}

    best = None
    best_conf = 0.0
    for c in candidates:
        # Fotmob payloads often have fields like home_team / away_team or h / a
        h = c.get("home_team") or c.get("homeTeam") or c.get("h", {}).get("name") or ""
        a = c.get("away_team") or c.get("awayTeam") or c.get("a", {}).get("name") or ""
        score = c.get("status") or c.get("score") or c.get("aggregate")
        if not h or not a:
            continue
        sh = _name_similarity(home, h)
        sa = _name_similarity(away, a)
        avg = (sh + sa) / 2
        if avg < 0.55:
            continue
        # Try to find score
        hs = c.get("home_score") if c.get("home_score") is not None else (
            c.get("h", {}).get("score") if isinstance(c.get("h"), dict) else None)
        as_ = c.get("away_score") if c.get("away_score") is not None else (
            c.get("a", {}).get("score") if isinstance(c.get("a"), dict) else None)
        if hs is None or as_ is None:
            continue
        try:
            hs_i = int(hs); as_i = int(as_)
        except (ValueError, TypeError):
            continue
        conf = round(avg * 100, 1)
        if conf > best_conf:
            best = {"home_score": hs_i, "away_score": as_i, "confidence": conf,
                    "matched_home": h, "matched_away": a, "matched_date": day, "source": "fotmob"}
            best_conf = conf

    if best:
        return {"found": True, **best}
    return {"found": False, "reason": "no fotmob match"}
    """Search TheSportsDB (free public API) for a finished match.
    Note: original name kept for compatibility; sources may evolve.
    Returns score dict or {'found': False}.
    """
    target_date = day  # 'YYYY-MM-DD'

    # Step 1: Try TheSportsDB direct event search
    # API: https://www.thesportsdb.com/api/v1/json/3/searchevents.php?e=Home_vs_Away
    def make_query(h: str, a: str) -> str:
        # TheSportsDB expects "Home_vs_Away" with underscores
        return f"{h.strip().replace(' ', '_')}_vs_{a.strip().replace(' ', '_')}"

    try:
        q = make_query(home, away)
        url = f"https://www.thesportsdb.com/api/v1/json/3/searchevents.php?e={q}"
        r = await http.get(url, timeout=15.0, headers={"User-Agent": "Mozilla/5.0"})
        if r.status_code != 200:
            return {"found": False, "reason": f"search http {r.status_code}"}
        data = r.json()
        events = data.get("event") or []
    except Exception as e:
        return {"found": False, "reason": f"search err: {e}"}

    if not events:
        return {"found": False, "reason": "no events"}

    best = None
    best_conf = 0.0
    for ev in events:
        ev_home = ev.get("strHomeTeam") or ""
        ev_away = ev.get("strAwayTeam") or ""
        ev_date = ev.get("dateEvent") or ""  # 'YYYY-MM-DD'
        if not ev_date:
            continue
        try:
            d_target = datetime.strptime(target_date, "%Y-%m-%d").date()
            d_ev = datetime.strptime(ev_date, "%Y-%m-%d").date()
            if abs((d_ev - d_target).days) > 1:
                continue
        except Exception:
            continue
        sh = _name_similarity(home, ev_home)
        sa = _name_similarity(away, ev_away)
        avg = (sh + sa) / 2
        if avg < 0.55:
            continue
        hs = ev.get("intHomeScore")
        as_ = ev.get("intAwayScore")
        if hs is None or as_ is None or hs == "" or as_ == "":
            continue
        try:
            hs_i = int(hs)
            as_i = int(as_)
        except (ValueError, TypeError):
            continue
        conf = round(avg * 100, 1)
        if conf > best_conf:
            best = {
                "home_score": hs_i,
                "away_score": as_i,
                "confidence": conf,
                "matched_home": ev_home,
                "matched_away": ev_away,
                "matched_date": ev_date,
            }
            best_conf = conf

    if best:
        return {"found": True, **best}
    return {"found": False, "reason": "no match found in date range"}


class ResultsFetchRequest(BaseModel):
    ids: List[str] = []
    apply: bool = True   # if True and confidence >= apply_threshold, auto-save result
    apply_threshold: float = 80.0


@api_router.post("/results/fetch")
async def fetch_results(req: ResultsFetchRequest):
    """Auto-fetch results from Sofascore for the given match IDs (typically the Schedina).
    Returns per-match status with confidence. If apply=True, results with confidence above
    the threshold are saved directly; lower-confidence matches are reported for manual review.
    """
    if not req.ids:
        return {"results": [], "applied": 0, "skipped": 0, "not_found": 0}

    matches = await db.matches.find({"id": {"$in": req.ids}}, {"_id": 0}).to_list(len(req.ids))
    out = []
    applied = 0
    not_found = 0
    skipped = 0

    async with httpx.AsyncClient(http2=False) as http:
        # Parallel fetch (limit concurrency to 4 to avoid rate-limits)
        sem = asyncio.Semaphore(4)

        async def do_one(m: dict):
            async with sem:
                if m.get("result"):
                    return {"id": m["id"], "status": "already_set", "score": m["result"]}
                info = await _fetch_sofascore_match(
                    http,
                    m.get("squadra1") or "",
                    m.get("squadra2") or "",
                    m.get("day") or "",
                )
                # Fallback to Fotmob if TheSportsDB didn't find the match
                if not info.get("found"):
                    info_fm = await _fetch_fotmob_match(
                        http,
                        m.get("squadra1") or "",
                        m.get("squadra2") or "",
                        m.get("day") or "",
                    )
                    if info_fm.get("found"):
                        info = info_fm
                if not info.get("found"):
                    return {"id": m["id"], "status": "not_found", "reason": info.get("reason", "")}
                score_str = f"{info['home_score']}-{info['away_score']}"
                conf = info.get("confidence", 0.0)
                # Decide
                if req.apply and conf >= req.apply_threshold:
                    # Save result + recalculate ML stats
                    update = {"result": score_str}
                    await db.matches.update_one({"id": m["id"]}, {"$set": update})
                    # Recompute scores
                    pred = m.get("prediction") or {}
                    if pred:
                        try:
                            await update_market_scores(m, pred, info["home_score"], info["away_score"])
                        except Exception as e:
                            logging.warning("update_market_scores err: %s", e)
                    return {"id": m["id"], "status": "applied", "score": score_str,
                            "confidence": conf, "matched": info.get("matched_home") + " vs " + info.get("matched_away")}
                else:
                    return {"id": m["id"], "status": "review", "score": score_str,
                            "confidence": conf, "matched": info.get("matched_home", "") + " vs " + info.get("matched_away", "")}

        results = await asyncio.gather(*[do_one(m) for m in matches], return_exceptions=True)

    for r in results:
        if isinstance(r, Exception):
            out.append({"status": "error", "reason": str(r)})
            continue
        out.append(r)
        st = r.get("status")
        if st == "applied":
            applied += 1
        elif st == "not_found":
            not_found += 1
        elif st in ("review", "already_set"):
            skipped += 1

    return {"results": out, "applied": applied, "not_found": not_found, "skipped": skipped}


@api_router.get("/match/{match_id}/candidates")
async def match_candidates(match_id: str):
    """Return YELLOW candidate markets for a match (markets with high miss_rate in its family).
    Used to surface 'opportunità non sfruttate' alongside the pre-pronostic pyramid.
    """
    m = await db.matches.find_one({"id": match_id}, {"_id": 0})
    if not m:
        raise HTTPException(404, "match not found")
    # If we don't yet know the family of the match (no AI prediction), surface candidates from
    # ALL families so the user sees potential opportunities. Otherwise restrict to its family.
    family = (m.get("prediction") or {}).get("family") or m.get("family")
    league = m.get("manifestazione")

    # Family counter
    counter = await db.family_counters.find_one(
        {"family": family, "$or": [{"league": None}, {"league": {"$exists": False}}]}
    ) if family else None
    family_total = counter.get("matches", 0) if counter else 0

    query = {
        "$and": [
            {"$or": [{"league": None}, {"league": {"$exists": False}}]},
            {"$or": [{"total": {"$lte": 0}}, {"total": {"$exists": False}}]},
        ],
    }
    if family:
        query["family"] = family
    docs = await db.market_scores.find(query, {"_id": 0}).to_list(100)
    out = []
    for d in docs:
        missed = d.get("missed_wins", 0)
        if missed < 5:
            continue
        ft = family_total or 0
        miss_rate = (missed / ft * 100) if ft > 0 else 0
        if miss_rate < 50:
            continue
        out.append({
            "market": d.get("market"),
            "family": d.get("family"),
            "missed": missed,
            "family_total": ft,
            "miss_rate": round(miss_rate, 1),
        })
    out.sort(key=lambda x: -x["miss_rate"])
    return {"candidates": out, "family": family, "family_total": family_total}


@api_router.get("/match/{match_id}/history")
async def match_history(match_id: str):
    """Return global + per-league historical stats used by the AI prompt for this match."""
    m = await db.matches.find_one({"id": match_id}, {"_id": 0})
    if not m:
        raise HTTPException(404, "match not found")
    league = m.get("manifestazione")
    global_docs = await db.market_scores.find(
        {"$or": [{"league": None}, {"league": {"$exists": False}}]},
        {"_id": 0}
    ).sort("total", -1).to_list(100)
    league_docs = await db.market_scores.find({"league": league}, {"_id": 0}).sort("total", -1).to_list(100) if league else []

    def fmt(docs):
        out: Dict[str, list] = {}
        for d in docs:
            total = d.get("total", 0)
            missed = d.get("missed_wins", 0)
            if total == 0 and missed == 0:
                continue
            wins = d.get("wins", 0)
            rate = (wins / total * 100) if total > 0 else 0
            fam = d.get("family", "")
            out.setdefault(fam, []).append({
                "market": d.get("market"),
                "wins": wins,
                "total": total,
                "win_rate": round(rate, 1),
                "missed": missed,
            })
        return out
    return {
        "league": league,
        "global": fmt(global_docs),
        "league_specific": fmt(league_docs),
    }


@api_router.post("/results/apply")
async def results_apply(body: dict):
    """Manual apply of a reviewed Sofascore result (after user confirmation in UI)."""
    match_id = body.get("id")
    score = body.get("score")
    if not match_id or not score:
        raise HTTPException(400, "id and score required")
    m = await db.matches.find_one({"id": match_id}, {"_id": 0})
    if not m:
        raise HTTPException(404, "match not found")
    parts = score.split("-")
    if len(parts) != 2:
        raise HTTPException(400, "invalid score")
    try:
        hs, as_ = int(parts[0]), int(parts[1])
    except ValueError:
        raise HTTPException(400, "invalid score numbers")
    await db.matches.update_one({"id": match_id}, {"$set": {"result": score}})
    pred = m.get("prediction") or {}
    if pred:
        try:
            await update_market_scores(m, pred, hs, as_)
        except Exception as e:
            logging.warning("update_market_scores err: %s", e)
    return {"ok": True, "result": score}


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
    csv_lines = ["Ora,Lega,Competizione,Casa,Ospite,1,X,2,1X,X2,U1.5,O1.5,U2.5,O2.5,U3.5,O3.5,GG,NG"]
    for m in selected:
        o = m.get('odds', {})
        def v(k):
            x = o.get(k)
            return "" if x is None else str(x)
        # Sanitize commas in team / league names
        def s(x): return str(x).replace(',', ' ').strip()
        comp_label = parse_league_label(m['manifestazione']) or ""
        csv_lines.append(",".join([
            m['time'], s(m['manifestazione']), s(comp_label), s(m['squadra1']), s(m['squadra2']),
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

# ============================================================
# CORS — Whitelist esplicita per produzione + dev locale
# ============================================================
# Origini autorizzate esplicitamente (produzione + Netlify deploy previews + locale)
ALLOWED_ORIGINS = [
    "https://scoreblast-app.netlify.app",          # Netlify produzione
    "https://match-quota-analyzer.emergent.host",  # Backend produzione (self)
    "https://match-quota-analyzer.preview.emergentagent.com",  # Preview Emergent
    "http://localhost:3000",                       # Expo web dev
    "http://localhost:8081",                       # Expo metro dev
    "http://localhost:19006",                      # Expo web legacy
    "http://127.0.0.1:3000",
    "http://127.0.0.1:8081",
]

# Regex per coprire Netlify deploy previews (es. deploy-preview-12--scoreblast-app.netlify.app)
# e branch deploys (es. main--scoreblast-app.netlify.app)
ALLOWED_ORIGIN_REGEX = r"^https://([a-z0-9-]+--)?scoreblast-app\.netlify\.app$"

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()

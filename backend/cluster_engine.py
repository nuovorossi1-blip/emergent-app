"""
Motore di Inferenza Strutturale Quote
=====================================
Score Cluster Simulator (Poisson) + Market Coverage + Fragility + Family Classifier
"""

from math import exp, factorial
from typing import Dict, List, Optional, Tuple


# ---- Poisson helpers ----------------------------------------------------------

def _poisson(k: int, lam: float) -> float:
    if lam <= 0:
        return 1.0 if k == 0 else 0.0
    return (lam ** k) * exp(-lam) / factorial(k)


def _implied_prob(odd: Optional[float]) -> float:
    if not odd or odd <= 1.0:
        return 0.0
    return 1.0 / odd


def derive_lambdas(odds: Dict) -> Tuple[float, float]:
    """Derive λ_home, λ_away from bookmaker odds.
    Uses O/U 2.5 to estimate total goals + 1X2 balance for split.
    """
    # Total expected goals — approximate by mapping O2.5/U2.5 to expected total
    o25 = odds.get("odd_O25") or odds.get("odd_o25") or 0
    u25 = odds.get("odd_U25") or odds.get("odd_u25") or 0
    # Implied probability of Over 2.5
    p_over25 = 0
    if o25 and u25:
        p_o = _implied_prob(o25)
        p_u = _implied_prob(u25)
        s = p_o + p_u
        p_over25 = p_o / s if s > 0 else 0.5
    else:
        p_over25 = 0.5

    # Map p_over25 to total lambda using empirical Poisson inversion
    # p_over25 = 0.40 → λ ≈ 2.3; 0.50 → λ ≈ 2.6; 0.60 → λ ≈ 2.9; 0.70 → λ ≈ 3.2
    lam_total = 2.0 + (p_over25 - 0.30) * 3.5
    lam_total = max(1.5, min(4.5, lam_total))

    # Split by 1X2 strength (include X with half-weight for both teams)
    o1 = odds.get("odd_1") or 0
    o2 = odds.get("odd_2") or 0
    oX = odds.get("odd_X") or 0
    p1 = _implied_prob(o1)
    p2 = _implied_prob(o2)
    pX = _implied_prob(oX)
    # Win + half of draw probability = team strength
    home_strength = p1 + pX * 0.5
    away_strength = p2 + pX * 0.5
    s = (home_strength + away_strength) or 1.0
    home_share = home_strength / s
    away_share = away_strength / s

    # Reciprocity adjustment using GG/NG:
    # If GG > NG, both teams likely score → compress shares slightly toward 50/50.
    # NEVER swap roles (the favorite stays the favorite).
    p_gg = _implied_prob(odds.get("odd_GG") or 0)
    p_ng = _implied_prob(odds.get("odd_NG") or 0)
    if p_gg + p_ng > 0:
        gg_factor = p_gg / (p_gg + p_ng)  # 0..1
        if gg_factor > 0.5:
            # Max blend: 25% toward 50/50 when GG very strong
            blend = (gg_factor - 0.5) * 0.5
            home_share = home_share * (1 - blend) + 0.5 * blend
            away_share = 1.0 - home_share

    lam_home = lam_total * home_share
    lam_away = lam_total * away_share
    return round(lam_home, 3), round(lam_away, 3)


# ---- Cluster simulator --------------------------------------------------------

def simulate_cluster(odds: Dict, max_goals: int = 6, top_k: int = 12) -> List[Dict]:
    """Return list of {score, p, compatibility} ordered by probability desc.
    Probabilities normalized to sum 1.0.
    """
    lam_h, lam_a = derive_lambdas(odds)
    grid = []
    for h in range(max_goals + 1):
        for a in range(max_goals + 1):
            p = _poisson(h, lam_h) * _poisson(a, lam_a)
            grid.append((h, a, p))
    total = sum(g[2] for g in grid) or 1.0
    grid = [(h, a, p / total) for h, a, p in grid]
    grid.sort(key=lambda x: -x[2])
    out = []
    for h, a, p in grid[:top_k]:
        if p < 0.005:
            break
        comp = "high" if p >= 0.10 else ("medium" if p >= 0.06 else "low")
        out.append({"score": f"{h}-{a}", "home": h, "away": a, "p": round(p, 4), "compatibility": comp})
    return out


# ---- Market evaluator (mirror of frontend) ------------------------------------

def evaluate_market_strict(market: str, home: int, away: int) -> Optional[bool]:
    """Local evaluator (used for coverage). Returns True/False or None if unknown."""
    total = home + away
    m = market.strip().upper().replace("  ", " ")
    if m == "1":
        return home > away
    if m == "X":
        return home == away
    if m == "2":
        return away > home
    if m in ("1X", "DC 1X"):
        return home >= away
    if m in ("X2", "DC X2"):
        return away >= home
    if m in ("12", "DC 12"):
        return home != away
    if m == "GG":
        return home > 0 and away > 0
    if m == "NG":
        return home == 0 or away == 0
    for o in ["0.5", "1.5", "2.5", "3.5", "4.5", "5.5"]:
        if m == f"O{o}":
            return total > float(o)
        if m == f"U{o}":
            return total < float(o)
    # MG (Multi Goal) generic: any range "A-B" applied to totale/casa/ospite
    # Esempi: "MG 1-3 totali", "MG 0-2 totali", "MG 2-4 casa", "MG 1-3 ospite"
    if "MG" in m:
        import re as _re
        rng = _re.search(r"(\d+)\s*-\s*(\d+)", m)
        if rng:
            lo, hi = int(rng.group(1)), int(rng.group(2))
            if "CASA" in m:
                return lo <= home <= hi
            if "OSPITE" in m:
                return lo <= away <= hi
            return lo <= total <= hi
    if "+" in market:
        parts = [p.strip() for p in market.split("+")]
        results = [evaluate_market_strict(p, home, away) for p in parts]
        if any(r is None for r in results):
            return None
        return all(results)
    return None


# ---- Coverage + Fragility -----------------------------------------------------

def coverage_for_market(market: str, cluster: List[Dict]) -> Tuple[float, List[str], List[str]]:
    """Return (coverage_fraction, covered_scores, broken_by_scores) on the cluster."""
    if not cluster:
        return 0.0, [], []
    total_p = sum(c["p"] for c in cluster) or 1.0
    covered = []
    broken = []
    cov_p = 0.0
    for c in cluster:
        outcome = evaluate_market_strict(market, c["home"], c["away"])
        if outcome is True:
            covered.append(c["score"])
            cov_p += c["p"]
        elif outcome is False:
            broken.append(c["score"])
    return round(cov_p / total_p, 4), covered, broken


def fragility_score(market: str, cluster: List[Dict]) -> float:
    """Fragility = fraction of cluster where the market FAILS.
    Higher = more fragile."""
    if not cluster:
        return 0.0
    total_p = sum(c["p"] for c in cluster) or 1.0
    fail_p = 0.0
    for c in cluster:
        outcome = evaluate_market_strict(market, c["home"], c["away"])
        if outcome is False:
            fail_p += c["p"]
    return round(fail_p / total_p, 4)


# ---- Family classifier --------------------------------------------------------

def classify_family(odds: Dict) -> Dict:
    """Classify match into one of the 5 tactical families.
    Returns dict with: family, dominance, offensive_profile, goal_compression,
    goal_floor, goal_ceiling, goal_range.
    """
    o1 = odds.get("odd_1") or 99
    o2 = odds.get("odd_2") or 99
    oX = odds.get("odd_X") or 99
    oGG = odds.get("odd_GG") or 99
    oNG = odds.get("odd_NG") or 99
    oO15 = odds.get("odd_O15") or 99
    oU15 = odds.get("odd_U15") or 99
    oO25 = odds.get("odd_O25") or 99
    oU25 = odds.get("odd_U25") or 99
    oU35 = odds.get("odd_U35") or 99
    oO35 = odds.get("odd_O35") or 99

    # Dominance
    if o1 <= 1.50:
        dominance = "strong_home"
    elif o1 <= 1.85:
        dominance = "light_home"
    elif o2 <= 1.50:
        dominance = "strong_away"
    elif o2 <= 1.85:
        dominance = "light_away"
    else:
        dominance = "none"

    # Offensive profile from GG/NG
    if oGG <= 1.65:
        offensive_profile = "reciprocity_high"
    elif oGG <= 1.85:
        offensive_profile = "moderate"
    elif oNG <= 1.70:
        offensive_profile = "defensive"
    else:
        offensive_profile = "neutral"

    # ============================================================
    # GOAL FLOOR — con borderline step-DOWN per sicurezza
    # ============================================================
    # Principio: in zona borderline (incertezza tra 2 livelli),
    # prendere il valore PIÙ BASSO per ampliare il range di sicurezza.
    # - Floor=2 STRICT: O1.5 ≤ 1.20 AND U1.5 ≥ 4.00 (clear over 1.5)
    # - Floor=2 NORMAL: O1.5 ≤ 1.30 AND U1.5 ≥ 3.00 (es. Slovacchia O1.5=1.30/U1.5=3.10)
    # - Floor=1 BORDERLINE: scartato (border 2-1 → step DOWN a 0/1 a seconda dei dati)
    # - Floor=0: tutto il resto (es. Kamatamare O1.5=1.33/U1.5=2.80)
    # ============================================================
    if oO15 <= 1.20 and oU15 >= 4.00:
        goal_floor = 2  # super strict
    elif oO15 <= 1.30 and oU15 >= 3.00:
        goal_floor = 2  # strict (Slovacchia case)
    else:
        # Zona borderline o chiara → step DOWN per sicurezza
        # P(0-0) può essere ≥ 10%, meglio considerare 0 come floor
        goal_floor = 0

    # ============================================================
    # GOAL CEILING — con borderline step-UP per sicurezza
    # ============================================================
    # Principio: in zona borderline (incertezza tra 2 livelli),
    # prendere il valore PIÙ ALTO per ampliare il range di sicurezza.
    #
    # Esempio Slovacchia-Montenegro: U3.5=1.27, O3.5=3.25
    # → con vecchia logica ceiling=3 (U3.5 ≤ 1.35)
    # → MA risultato 2-2 = 4 gol → ceiling=3 SBAGLIATO
    # → Nuova logica: borderline 3-4 → ceiling=4 ✓
    #
    # Esempio Myanmar-Guam: U3.5=1.80, O3.5=1.85
    # → ceiling APERTO (O3.5 < 2.20)
    #
    # Esempio borderline 4-open: U3.5=1.70, O3.5=2.30
    # → step UP a APERTO (massima sicurezza)
    # ============================================================
    if oU25 <= 1.40:
        # Ceiling=2 strict
        goal_ceiling = 2
        goal_ceiling_open = False
    elif oU35 <= 1.15:
        # Ceiling=3 STRICT: U3.5 estremamente sicuro (no borderline)
        goal_ceiling = 3
        goal_ceiling_open = False
    elif oU35 <= 1.40 and oO35 >= 3.00:
        # BORDERLINE 3-4: U3.5 forte ma non estremo, O3.5 conferma tetto
        # → step UP a 4 per sicurezza (Slovacchia case 1.27/3.25)
        goal_ceiling = 4
        goal_ceiling_open = False
    elif oU35 <= 1.85 and oO35 >= 2.50:
        # Ceiling=4 NORMAL: doppia conferma robusta
        goal_ceiling = 4
        goal_ceiling_open = False
    elif oU35 <= 1.85 and oO35 >= 2.20:
        # BORDERLINE 4-open: O3.5 in zona grigia (2.20-2.50)
        # → step UP a APERTO per sicurezza
        goal_ceiling = 7
        goal_ceiling_open = True
    else:
        # Tetto APERTO chiaro: O3.5 < 2.20 (Myanmar case)
        goal_ceiling = 7
        goal_ceiling_open = True
        # Usiamo 7 come valore numerico per coerenza math (MG 2-7 = open),
        # ma il flag goal_ceiling_open=True segnala "no limite".
        goal_ceiling = 7
        goal_ceiling_open = True

    goal_compression = "high" if (oU35 <= 1.40 and oO35 >= 2.80) else (
        "medium" if oU35 <= 1.70 else "low"
    )

    # Classify family
    # Extreme favorite: bookmaker prices one side at ≤1.35 → monopolio offensivo
    extreme_fav = (o1 <= 1.35) or (o2 <= 1.35)
    has_favorite = (o1 <= 1.85 or o2 <= 1.85)
    is_offensive = (oO25 <= 1.85 or oGG <= 1.85)
    is_closed = (oU25 <= 1.70 or oNG <= 1.70)

    # PRIORITÀ: tetto aperto + favorita → DOMINANZA_OVER (no compromessi)
    # Questo previene il caso Myanmar (favorita estrema + tetto aperto
    # classificato erroneamente come DOMINANZA_CHIUSA).
    if goal_ceiling_open and has_favorite:
        family = "DOMINANZA_OVER"
    elif goal_ceiling_open and is_offensive:
        family = "EQUILIBRATA_OFFENSIVA"
    elif not has_favorite and is_offensive and goal_ceiling <= 4:
        family = "EQUILIBRATA_OFFENSIVA"
    elif not has_favorite and is_closed:
        family = "EQUILIBRATA_CHIUSA"
    # DOMINANZA_CHIUSA: favorita estrema + NG vivo + tetto ancora forte
    # (es. quota 1.24 + NG 1.75 + U3.5 1.50) → clean sheet + range controllato
    elif extreme_fav and oNG <= 1.95 and oU35 <= 1.65:
        family = "DOMINANZA_CHIUSA"
    # DOMINANZA_CON_TETTO: favorita + ceiling chiuso ≤ 4
    # (include sia il caso "tight tetto 3" che "borderline step-up 4")
    elif has_favorite and goal_ceiling <= 4 and not goal_ceiling_open:
        family = "DOMINANZA_CON_TETTO"
    elif has_favorite and oO25 <= 1.65:
        family = "DOMINANZA_OVER"
    elif goal_ceiling <= 2:
        family = "BLOCCATA"
    else:
        family = "INSTABILE"

    return {
        "family": family,
        "dominance": dominance,
        "offensive_profile": offensive_profile,
        "goal_compression": goal_compression,
        "goal_floor": goal_floor,
        "goal_ceiling": goal_ceiling,
        "goal_ceiling_open": goal_ceiling_open,
        "goal_range": f"{goal_floor}-{'∞' if goal_ceiling_open else goal_ceiling}",
        "lambda_home": derive_lambdas(odds)[0],
        "lambda_away": derive_lambdas(odds)[1],
    }


# ---- Coherence filter ---------------------------------------------------------

INCOHERENCE_PAIRS = [
    ("1", "2"), ("1", "X"), ("1", "X2"),
    ("2", "X"), ("2", "1X"),
    ("1X", "X2"),
    ("GG", "NG"),
    ("O1.5", "U1.5"), ("O2.5", "U2.5"), ("O3.5", "U3.5"),
    # Cross thresholds (user request)
    ("O2.5", "U3.5"), ("O1.5", "U2.5"),
]


def _norm(m: str) -> str:
    return (m or "").strip().upper().replace("DC ", "").replace("  ", " ")


def are_incoherent(a: str, b: str) -> bool:
    na, nb = _norm(a), _norm(b)
    if na == nb:
        return False
    for x, y in INCOHERENCE_PAIRS:
        if (x in na and y in nb) or (x in nb and y in na):
            # Avoid false positives: "O1.5" should only match exact start
            if (na.startswith(x) and nb.startswith(y)) or (na.startswith(y) and nb.startswith(x)):
                return True
    # Combo direction: "DC X+O" vs "DC Y+U"
    if "+" in na and "+" in nb:
        if ("O" in na and "U" in nb) or ("U" in na and "O" in nb):
            return True
    return False


def filter_coherent(pick: str, candidates: List[Dict], market_key: str = "market") -> List[Dict]:
    """Remove candidates that are incoherent with the PICK."""
    return [c for c in candidates if not are_incoherent(pick, c.get(market_key, ""))]


# ---- Main entry: full structural analysis -------------------------------------

CANDIDATE_MARKETS = [
    "1", "X", "2", "1X", "X2", "12",
    "O1.5", "U1.5", "O2.5", "U2.5", "O3.5", "U3.5",
    "GG", "NG",
    # MG totali (NO "MG 0-X" — i bookmaker non offrono questo range,
    # è ridondante con Under N.5)
    "MG 1-2 totali", "MG 1-3 totali", "MG 1-4 totali",
    "MG 2-3 totali", "MG 2-4 totali", "MG 2-5 totali",
    "MG 3-4 totali", "MG 3-5 totali",
    # MG per singola squadra
    "MG 1-2 casa", "MG 1-3 casa", "MG 2-3 casa", "MG 2-4 casa",
    "MG 1-2 ospite", "MG 1-3 ospite", "MG 2-3 ospite", "MG 2-4 ospite",
    # Direct-result + Over combos (offensiva pulita con dominante)
    "1 + O1.5", "2 + O1.5", "1 + O2.5", "2 + O2.5",
    # Direct-result + Under combo: scorciatoia per casi specifici di dominanza
    # con tetto controllato, ammessa SOLO se ceiling ≤ 4 chiuso e segno puro <1.40
    # (es. Austria @ 1.36 con tetto 4 → 1 + U4.5 massimizza profitto)
    "1 + U4.5", "2 + U4.5",
    # GG + Over combos (entrambe segnano + over)
    "GG + O2.5",
    # Double-chance + Over/Under combos
    "DC 1X + O1.5", "DC X2 + O1.5", "DC 12 + O1.5",
    "DC 1X + O2.5", "DC X2 + O2.5", "DC 12 + O2.5",
    "DC 1X + U3.5", "DC X2 + U3.5", "DC 12 + U3.5",
    # Double-chance + GG combos
    "DC 1X + GG", "DC X2 + GG", "DC 12 + GG",
]


def _estimate_combo_odd_from_cluster(market: str, odds: Dict) -> Optional[float]:
    """Stima la quota di una combo direct+Under usando il cluster Poisson.
    
    Calcola P(combo) sul cluster completo, poi applica l'overround del book
    (1X2 medio) per dare una quota stimata realistica anziché "fair".
    """
    try:
        # Cluster completo Poisson (no top_k cut, prende l'intera griglia)
        lam_h, lam_a = derive_lambdas(odds)
        max_goals = 8
        total_p = 0.0
        match_p = 0.0
        for h in range(max_goals + 1):
            for a in range(max_goals + 1):
                p = _poisson(h, lam_h) * _poisson(a, lam_a)
                total_p += p
                outcome = evaluate_market_strict(market, h, a)
                if outcome is True:
                    match_p += p
        if total_p <= 0 or match_p <= 0:
            return None
        prob = match_p / total_p
        # Overround del book (1X2): tipicamente ~1.05-1.08
        p1 = _implied_prob(odds.get("odd_1") or 0)
        px = _implied_prob(odds.get("odd_X") or 0)
        p2 = _implied_prob(odds.get("odd_2") or 0)
        overround = (p1 + px + p2) if (p1 and px and p2) else 1.06
        # Quota stimata con overround applicato
        if overround <= 0:
            overround = 1.06
        fair_odd = 1.0 / prob
        # Bookmaker margin: scale down by overround share
        est = fair_odd / overround
        return round(est, 2) if est >= 1.01 else None
    except Exception:
        return None


def _combo_odd(market: str, odds: Dict) -> Optional[float]:
    """Compute combo odd. Per le combo con Under N.5 dove odd_UN5 non è
    disponibile come quota standard, stima dal cluster Poisson."""
    MAP = {
        "1": "odd_1", "X": "odd_X", "2": "odd_2",
        "1X": "odd_1X", "X2": "odd_X2", "12": "odd_12",
        "O1.5": "odd_O15", "U1.5": "odd_U15",
        "O2.5": "odd_O25", "U2.5": "odd_U25",
        "O3.5": "odd_O35", "U3.5": "odd_U35",
        "GG": "odd_GG", "NG": "odd_NG",
    }
    m = market.strip().upper().replace("DC ", "").replace("  ", " ")
    if m in MAP:
        return odds.get(MAP[m])
    if "+" in m:
        parts = [p.strip() for p in m.split("+")]
        # Se TUTTI i componenti hanno quota nel MAP → moltiplico
        vals = [odds.get(MAP.get(p, "")) for p in parts]
        if all(v and v > 0 for v in vals):
            return round(vals[0] * vals[1], 3)
        # Altrimenti stima dal cluster Poisson (es. "1 + U4.5")
        est = _estimate_combo_odd_from_cluster(market, odds)
        if est:
            return est
    return None


def structural_analysis(odds: Dict, min_odd: float = 1.40, ml_scores: Optional[Dict[str, Dict]] = None) -> Dict:
    """Full output: structure + cluster + ranked markets with coverage/fragility.
    
    `min_odd` filters out picks that don't provide betting value (default 1.40).
    
    `ml_scores` (optional): dict mapping market_name → {"win_rate": float (0-100),
        "total": int, "wins": int, "losses": int}. When provided AND total >= 10:
        - win_rate >= 70% → +10% boost on final score (mercato sale)
        - win_rate <= 30% → -10% malus on final score (mercato scende)
        - 30 < win_rate < 70 → neutral
        - total < 10 → neutral (poca evidenza, no over-correction)
        This is the ML feedback loop: storico empirico aggiusta la classifica
        matematica del motore Poisson SENZA stravolgerla (boost conservativo).
    """
    structure = classify_family(odds)
    cluster = simulate_cluster(odds, top_k=12)
    central = cluster[:8]
    lam_h = structure["lambda_home"]
    lam_a = structure["lambda_away"]
    lam_min = min(lam_h, lam_a)
    lam_max = max(lam_h, lam_a)

    # Filter markets by basic odds rules
    valid_markets = []
    for m in CANDIDATE_MARKETS:
        # Skip direct signs if their odds > 1.85 (regola assoluta)
        if m == "1" and (odds.get("odd_1") or 99) > 1.85:
            continue
        if m == "2" and (odds.get("odd_2") or 99) > 1.85:
            continue
        if m == "X" and (odds.get("odd_X") or 99) > 3.50:
            continue
        if m == "1X" and (odds.get("odd_1X") or 99) > 1.85:
            continue
        if m == "X2" and (odds.get("odd_X2") or 99) > 1.85:
            continue
        if m == "12" and (odds.get("odd_12") or 99) > 1.85:
            continue
        # Skip combos "X + O1.5" if base sign is unavailable / too short
        if m == "1 + O1.5" and (odds.get("odd_1") or 99) > 1.85:
            continue
        if m == "2 + O1.5" and (odds.get("odd_2") or 99) > 1.85:
            continue
        # Apply min_odd filter using computed combo odds
        combo_odd = _combo_odd(m, odds)
        if combo_odd is not None and combo_odd < min_odd:
            continue
        valid_markets.append(m)

    ranked = []
    floor = structure["goal_floor"]
    ceiling = structure["goal_ceiling"]
    ceiling_open = structure.get("goal_ceiling_open", False)

    # === FILTRO STRUTTURALE FLOOR/CEILING (regola severa utente) ===
    # Esclude a priori mercati incoerenti con la "banda" floor..ceiling.
    # FLOOR ≥ N → escludi Under con soglia ≤ N+1 (banda troppo stretta o impossibile)
    # CEILING chiuso ≤ N → escludi Over con soglia ≥ N-0.5 (banda troppo stretta o impossibile)
    import re as _re_pre
    _vm_filtered = []
    for m in valid_markets:
        mu = m.upper().strip()

        # ---- FLOOR exclusions ----
        # U0.5 / U1.5 / U2.5 / U3.5 esclusi se la banda di copertura è troppo stretta
        if mu == "U0.5":
            continue  # quasi mai utile
        if mu == "U1.5" and floor >= 1:
            continue
        if mu == "U2.5" and floor >= 2:
            continue
        if mu == "U3.5" and floor >= 2:
            continue  # nuova regola severa utente

        # FLOOR garantisce O1.5/O2.5: combo con quegli Over sono RIDONDANTI
        # (la combo equivale al segno puro). Escludi per evitare doppioni.
        if floor >= 2:
            # O1.5 puro o combo che lo includono → ridondanti (Over 1.5 è certo)
            if mu == "O1.5":
                continue
            if "+ O1.5" in mu:
                continue
            if mu in ("1 + O1.5", "2 + O1.5"):
                continue
        if floor >= 3:
            if mu == "O2.5":
                continue
            if "+ O2.5" in mu:
                continue

        # MG totali che iniziano sotto floor → ridondanti
        if "MG" in mu and "TOTALI" in mu:
            rng = _re_pre.search(r"(\d+)\s*-\s*(\d+)", m)
            if rng:
                lo = int(rng.group(1))
                if lo < floor:
                    continue
        # Combo "DC X + Under N" RIABILITATE: sono mercati standard book.
        # Restano esclusi solo i casi banali di ridondanza puramente tautologica.
        # Es. "DC 1X + U1.5" con floor=1 → Under 1.5 impossibile → escludi.
        if mu.startswith("DC ") and "+ U1.5" in mu and floor >= 1:
            continue
        if mu.startswith("DC ") and "+ U2.5" in mu and floor >= 2:
            continue
        # DC + U3.5 ammessa anche con floor=2 (mercato standard, banda 2-3 stretta ma valida)

        # === Combo "1 + UN.5" / "2 + UN.5" — SCORCIATOIE PER DOMINANZA + TETTO ===
        # Regola utente: usate SOLO per massimizzare profitto quando il segno
        # puro è sotto soglia 1.40 (es. Austria 1@1.36 + U4.5 → quota 1.55+).
        # Ammesse SOLO se il ceiling è coerente (chiuso e adeguato).
        odd_1 = odds.get("odd_1") or 99.0
        odd_2 = odds.get("odd_2") or 99.0
        if mu == "1 + U4.5":
            # Solo se ceiling chiuso ≤ 4 (tetto entro 4 gol) E quota 1 < 1.40
            if ceiling_open or ceiling > 4:
                continue
            if odd_1 >= 1.40:
                continue
        elif mu == "2 + U4.5":
            if ceiling_open or ceiling > 4:
                continue
            if odd_2 >= 1.40:
                continue

        # ---- CEILING exclusions ----
        if not ceiling_open:
            if mu == "O3.5" and ceiling <= 3:
                continue
            if mu == "O2.5" and ceiling <= 3:
                continue  # nuova regola severa utente
            if mu == "O1.5" and ceiling <= 2:
                continue
            # CEILING stretto garantisce U3.5/U2.5: combo con Under sono RIDONDANTI
            if ceiling <= 3:
                if mu == "U3.5":
                    continue
                if "+ U3.5" in mu:
                    continue
            if ceiling <= 2:
                if mu == "U2.5":
                    continue
                if "+ U2.5" in mu:
                    continue
            # MG totali che finiscono sopra ceiling → ridondanti
            if "MG" in mu and "TOTALI" in mu:
                rng = _re_pre.search(r"(\d+)\s*-\s*(\d+)", m)
                if rng:
                    hi = int(rng.group(2))
                    if hi > ceiling:
                        continue
            # Combo "DC X + Over N" escluse con ceiling incompatibile
            if "+ O3.5" in mu and ceiling <= 3:
                continue
            if "+ O2.5" in mu and ceiling <= 3:
                continue
            if "+ O1.5" in mu and ceiling <= 2:
                continue
            # "1 + O1.5" / "2 + O1.5" escluse se Over fuori ceiling
            if mu in ("1 + O1.5", "2 + O1.5") and ceiling <= 2:
                continue

        _vm_filtered.append(m)
    valid_markets = _vm_filtered

    for m in valid_markets:
        cov, covered, broken = coverage_for_market(m, central)
        frag = fragility_score(m, central)
        # Skip if coverage < 30%
        if cov < 0.30:
            continue
        # Base score = coverage × (1 - fragility×0.3)
        score = cov * (1 - frag * 0.3)

        # === MG "PERFETTO": boost quando il range combacia con [floor, ceiling] ===
        # Esempio: floor=1, ceiling=3 → "MG 1-3 totali" è il pronostico più calibrato
        # alla struttura del match → riceve un +25% bonus.
        # ANTI-LADRO: MG troppo ampi (span ≥ 4) sono ad alta coverage ma a quota
        # ridicola (~1.10) → penalità per scoraggiare il PICK quando ci sono
        # alternative più calibrate.
        import re as _re
        if "MG" in m.upper():
            rng = _re.search(r"(\d+)\s*-\s*(\d+)", m)
            if rng:
                lo, hi = int(rng.group(1)), int(rng.group(2))
                span = hi - lo
                MU = m.upper()
                is_totali = "TOTALI" in MU
                is_casa = "CASA" in MU
                is_ospite = "OSPITE" in MU

                if is_totali:
                    if lo == floor and hi == ceiling:
                        score *= 1.30
                    elif abs(lo - floor) <= 1 and abs(hi - ceiling) <= 1:
                        score *= 1.10
                    # Penalty: MG totali con limite inferiore SOTTO il pavimento
                    # Esempio: floor=2, MG 1-3 totali → il "1" non si avvera mai,
                    # è ridondante = quota più bassa per niente valore extra.
                    if lo < floor:
                        score *= 0.55
                # MG casa/ospite: boost quando il range copre il lambda della squadra
                # MA penalty severa se il range parte da 1 (gol mai) e la squadra
                # ha λ ≥ 2.0 → significa che fa almeno 2 gol, il "1" è ridondante.
                elif is_casa:
                    lam = lam_h
                    if lo == 1 and lam >= 2.0:
                        # MG 1-X casa con team a λ≥2.0 = scelta debole (quota ~1.30)
                        score *= 0.45
                    # Penalty se il "1" del range è sotto il floor MA il team
                    # è forte abbastanza da non fermarsi a 1 (lam >= 1.6)
                    elif lo == 1 and lam >= 1.6 and floor >= 2:
                        score *= 0.65
                    elif lo <= lam <= hi and span <= 3:
                        score *= 1.25  # range calibrato sul lambda casa
                    elif lo > 0 and span <= 3:
                        score *= 1.05
                elif is_ospite:
                    lam = lam_a
                    if lo == 1 and lam >= 2.0:
                        score *= 0.45
                    elif lo == 1 and lam >= 1.6 and floor >= 2:
                        score *= 0.65
                    elif lo <= lam <= hi and span <= 3:
                        score *= 1.25  # range calibrato sul lambda ospite
                    elif lo > 0 and span <= 3:
                        score *= 1.05

                # Penalty: MG totali troppo ampi (es. MG 1-4, MG 1-5)
                # sono noiosi e con quote piatte → non hanno valore betting
                if is_totali:
                    if span >= 4 and cov >= 0.85:
                        score *= 0.55
                    elif span >= 3 and cov >= 0.90:
                        score *= 0.70

        # === Boost combo "DOMINANZA + TETTO" (1+U4.5 / 2+U4.5) ===
        # Caso Austria-Giordania: casa dominante e tetto chiuso ≤ 4.
        # Combo ammessa solo quando segno puro < 1.40 (filtro pre-ranking)
        if mu == "1 + U4.5" and lam_h >= lam_a + 0.8:
            score *= 1.35
        elif mu == "2 + U4.5" and lam_a >= lam_h + 0.8:
            score *= 1.35
        # Penalty se la dominanza NON c'è: combo direct+Under non ha senso
        elif mu == "1 + U4.5" and lam_h - lam_a < 0.30:
            score *= 0.55
        elif mu == "2 + U4.5" and lam_a - lam_h < 0.30:
            score *= 0.55

        # === MERCATI SECCHI: boost quando coerenti con la struttura ===
        # Questi sono i pronostici più importanti per il bettor: O2.5 secco,
        # GG secco, 1X/X2 secco. Vanno premiati quando combaciano con λ Poisson.
        lam_tot = lam_h + lam_a
        mu = m.upper().replace("  ", " ")
        # O2.5 secco: boost se lam_tot >= 2.8 (over moderato calibrato)
        if mu == "O2.5" and lam_tot >= 2.8:
            score *= 1.30
        # O1.5 secco: boost se entrambi i team segnano (alta reciprocity)
        elif mu == "O1.5" and lam_h >= 0.9 and lam_a >= 0.9:
            score *= 1.20
        # GG secco: boost se entrambi i team hanno λ >= 1.2
        elif mu == "GG" and lam_h >= 1.2 and lam_a >= 1.2:
            score *= 1.25
        # NG secco: boost ridotto. NG è poco "giocabile" come pick principale
        # secondo feedback utente (preferisce combo 1+U4.5 / 2+U4.5 leggibili).
        elif mu == "NG" and min(lam_h, lam_a) <= 0.75:
            score *= 1.05
        # === DOPPIE CHANCE: solo se DIREZIONE CHIARA ===
        # In equilibrio (gap λ < 0.30) NON scegliere 1X/X2/12: non c'è direzione,
        # il match va giocato su mercati neutri (X secco, GG, O/U, MG totali).
        # 12 in equilibrio è doppiamente assurdo: esclude X che è il risultato
        # più probabile quando lam_h ≈ lam_a.
        LAMBDA_GAP_DIR = 0.30  # soglia "direzione chiara"
        lambda_gap = abs(lam_h - lam_a)
        is_balanced = lambda_gap < LAMBDA_GAP_DIR
        # 1X: boost SOLO se casa è davvero favorita; penalty in equilibrio
        if mu == "1X":
            if lam_h - lam_a >= LAMBDA_GAP_DIR:
                score *= 1.20  # casa favorita reale
            elif is_balanced:
                score *= 0.50  # equilibrio: nessuna direzione → declassa
        # X2: boost SOLO se ospite è davvero favorito; penalty in equilibrio
        elif mu == "X2":
            if lam_a - lam_h >= LAMBDA_GAP_DIR:
                score *= 1.20  # ospite favorito reale
            elif is_balanced:
                score *= 0.50  # equilibrio: nessuna direzione → declassa
        # 12: doppia chance senza pareggio. In equilibrio il pareggio è probabile
        # quindi 12 è la scelta peggiore. Penalty severa.
        elif mu == "12" and is_balanced and lam_max < 2.2:
            score *= 0.45
        # Anche le combo "DC + Over" perdono direzione in equilibrio
        elif mu in ("DC 1X + O1.5", "DC X2 + O1.5", "DC 1X + O2.5", "DC X2 + O2.5", "DC 1X + GG", "DC X2 + GG", "DC 1X + U3.5", "DC X2 + U3.5") and is_balanced:
            score *= 0.65


        # Quando una squadra ha λ ≥ 2.4 (forte) e l'altra λ ≤ 0.7 (debole),
        # i risultati 0-3/0-4/1-3 sono molto vivi → premia chi li copre.
        is_extreme = (lam_min <= 0.7 and lam_max >= 2.2)
        if is_extreme:
            mu = m.upper().replace("  ", " ")
            # Boost ridotto: NG (clean sheet probabile, ma poco giocabile)
            if mu == "NG":
                score *= 1.05
            # Boost: combo "X + O1.5" del dominatore
            if (lam_a >= lam_h and mu in ("2 + O1.5", "DC X2 + O1.5")):
                score *= 1.25
            if (lam_h >= lam_a and mu in ("1 + O1.5", "DC 1X + O1.5")):
                score *= 1.25
            # Boost: combo "X + O2.5" del dominatore (over moderato con copertura)
            if (lam_a >= lam_h and mu in ("2 + O2.5", "DC X2 + O2.5")):
                score *= 1.30
            if (lam_h >= lam_a and mu in ("1 + O2.5", "DC 1X + O2.5")):
                score *= 1.30
            # Boost: O2.5 puro quando lam_total >= 2.8 (over moderato calibrato)
            lam_tot = lam_h + lam_a
            if mu == "O2.5" and lam_tot >= 2.8:
                score *= 1.20
            # Boost: combo dominanza + tetto controllato (alternativa elegante a NG)
            # "1 + U4.5" = "Casa domina, max 4 gol totali" → mercato leggibile
            if (lam_h >= lam_a and mu == "1 + U4.5"):
                score *= 1.30
            if (lam_a >= lam_h and mu == "2 + U4.5"):
                score *= 1.30
            # Malus: U3.5 puri (rotti facilmente da 0-4 / 1-3)
            if mu == "U3.5":
                score *= 0.80
            # Malus: MG 2-4 casa quando ospite domina (e viceversa)
            if "MG 2-4 CASA" in mu and lam_h < 1.0:
                score *= 0.50
            if "MG 2-4 OSPITE" in mu and lam_a < 1.0:
                score *= 0.50

        # ============================================================
        # TETTO APERTO (fix bug Myanmar 7-0): O3.5 < 2.20 → 4+ gol probabili
        # ============================================================
        # Quando il tetto è "aperto" (goal_ceiling_open=True) il mercato
        # vede ≥45% di chance ≥4 gol → penalty Under-based, boost Over-based.
        if structure.get("goal_ceiling_open"):
            mu_open = m.upper()
            # Penalty Under-based puri (forte: -45%)
            if mu_open in ("U3.5", "U2.5"):
                score *= 0.55
            # Penalty MG totali con upper bound ≤ 4 (rotti da 5-0/6-0)
            if "MG" in mu_open and "TOTALI" in mu_open:
                rng_o = _re.search(r"(\d+)\s*-\s*(\d+)", m)
                if rng_o:
                    hi_o = int(rng_o.group(2))
                    if hi_o <= 4:
                        score *= 0.65
                    elif hi_o == 5:
                        score *= 0.85
            # Penalty MG 2-3 / 1-3 casa/ospite (rotti dal team forte)
            if "MG 2-3" in mu_open or "MG 1-3" in mu_open:
                score *= 0.70
            # Penalty combo DC + Under
            if "+ U3.5" in m or "+ U2.5" in m:
                score *= 0.65
            # BOOST Over puri + GG (+30%)
            if mu_open in ("O2.5", "O3.5", "GG"):
                score *= 1.30
            # BOOST combo Over (+25%)
            if "+ O2.5" in m or "+ O1.5" in m:
                score *= 1.25
            # BOOST MG totali con upper bound 6+ (range aperti)
            if "MG" in mu_open and "TOTALI" in mu_open:
                rng_o2 = _re.search(r"(\d+)\s*-\s*(\d+)", m)
                if rng_o2:
                    hi_o2 = int(rng_o2.group(2))
                    if hi_o2 >= 6:
                        score *= 1.20

        ranked.append({
            "market": m,
            "coverage": cov,
            "fragility": frag,
            "fragility_label": ("alta" if frag >= 0.45 else "media" if frag >= 0.25 else "bassa"),
            "covered_scores": covered[:6],
            "broken_by": broken[:5],
            "score": round(score, 4),
            "odd": _combo_odd(m, odds),
        })

    # ============================================================
    # ML BOOST CONSERVATIVO (≥10 valutazioni storiche)
    # ============================================================
    # Applichiamo aggiustamento empirico al punteggio strutturale basato sul
    # win-rate storico nella stessa famiglia. Solo ≥10 valutazioni per evitare
    # over-correction su pochi dati (consiglio statistico).
    # - win_rate ≥ 70% → +10% boost  (mercato che storicamente vince → sale)
    # - win_rate ≤ 30% → -10% malus  (mercato che storicamente perde → scende)
    # - 30 < win_rate < 70 → neutro (zona grigia, no aggiustamento)
    # - total < 10 → neutro (dati insufficienti)
    if ml_scores:
        for r in ranked:
            sc = ml_scores.get(r["market"])
            if not sc:
                continue
            total = sc.get("total", 0)
            wr = sc.get("win_rate", 0)
            if total < 10:
                continue  # poca evidenza statistica
            if wr >= 70:
                r["score"] = round(r["score"] * 1.10, 4)
                r["ml_adjustment"] = {"type": "boost", "win_rate": wr, "total": total, "delta": "+10%"}
            elif wr <= 30:
                r["score"] = round(r["score"] * 0.90, 4)
                r["ml_adjustment"] = {"type": "malus", "win_rate": wr, "total": total, "delta": "-10%"}
            else:
                # Range 30-70: solo informativo, no aggiustamento
                r["ml_adjustment"] = {"type": "neutral", "win_rate": wr, "total": total, "delta": "0%"}

    ranked.sort(key=lambda x: -x["score"])

    # Apply coherence filter: alternatives must be coherent with PICK
    pick = ranked[0]["market"] if ranked else ""
    coherent = ranked[:1] + filter_coherent(pick, ranked[1:])

    return {
        "structure": structure,
        "cluster": cluster,
        "central_cluster": central,
        "ranking": coherent[:10],
        "pick": ranked[0] if ranked else None,
        "explanation": _build_explanation(structure, coherent),
    }


def _build_explanation(structure: Dict, ranking: List[Dict]) -> str:
    if not ranking:
        return "Nessun mercato con coverage sufficiente."
    p = ranking[0]
    fam = structure["family"]
    floor = structure["goal_floor"]
    ceil = structure["goal_ceiling"]
    pick = p["market"]
    cov = int(p["coverage"] * 100)
    return (
        f"Famiglia {fam}. Pavimento {floor} · Tetto {ceil} · Range {floor}-{ceil}. "
        f"PICK: {pick} con coverage {cov}% sul cluster centrale. "
        f"Fragility {p['fragility_label']} ({int(p['fragility']*100)}% del cluster lo batte)."
    )

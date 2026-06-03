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

    # Split by 1X2 strength
    o1 = odds.get("odd_1") or 0
    o2 = odds.get("odd_2") or 0
    p1 = _implied_prob(o1)
    p2 = _implied_prob(o2)
    s = (p1 + p2) or 1.0
    home_share = p1 / s
    away_share = p2 / s

    # Reciprocity adjustment using GG/NG
    p_gg = _implied_prob(odds.get("odd_GG") or 0)
    p_ng = _implied_prob(odds.get("odd_NG") or 0)
    if p_gg + p_ng > 0:
        gg_factor = p_gg / (p_gg + p_ng)
        # If GG strong → balance the shares (both score)
        balance = 0.5 + (1 - gg_factor) * (home_share - 0.5)
        home_share = balance if home_share > 0.5 else 1 - balance
        away_share = 1 - home_share

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
    for o in ["1.5", "2.5", "3.5"]:
        if m == f"O{o}":
            return total > float(o)
        if m == f"U{o}":
            return total < float(o)
    if "MG" in m and "2-4" in m:
        if "CASA" in m:
            return 2 <= home <= 4
        if "OSPITE" in m:
            return 2 <= away <= 4
        return 2 <= total <= 4
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

    # Goal floor
    if oO15 <= 1.30:
        goal_floor = 2
    elif oO15 <= 1.50:
        goal_floor = 1
    else:
        goal_floor = 0

    # Goal ceiling
    if oU25 <= 1.40:
        goal_ceiling = 2
    elif oU35 <= 1.35:
        goal_ceiling = 3
    elif oU35 <= 1.85:
        goal_ceiling = 4
    else:
        goal_ceiling = 5

    goal_compression = "high" if (oU35 <= 1.40 and oO35 >= 2.80) else (
        "medium" if oU35 <= 1.70 else "low"
    )

    # Classify family
    has_favorite = (o1 <= 1.85 or o2 <= 1.85)
    is_offensive = (oO25 <= 1.85 or oGG <= 1.85)
    is_closed = (oU25 <= 1.70 or oNG <= 1.70)

    if not has_favorite and is_offensive and goal_ceiling <= 4:
        family = "EQUILIBRATA_OFFENSIVA"
    elif not has_favorite and is_closed:
        family = "EQUILIBRATA_CHIUSA"
    elif has_favorite and goal_ceiling <= 3:
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
        "goal_range": f"{goal_floor}-{goal_ceiling}",
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
    "MG 2-4 totali", "MG 2-4 casa", "MG 2-4 ospite",
    "DC 1X + O1.5", "DC X2 + O1.5", "DC 12 + O1.5",
    "DC 1X + U3.5", "DC X2 + U3.5", "DC 12 + U3.5",
]


def structural_analysis(odds: Dict) -> Dict:
    """Full output: structure + cluster + ranked markets with coverage/fragility."""
    structure = classify_family(odds)
    cluster = simulate_cluster(odds, top_k=12)
    # Concentrate on top 8 for coverage calc (cluster centrale)
    central = cluster[:8]

    # Filter markets by basic odds rules
    valid_markets = []
    for m in CANDIDATE_MARKETS:
        # Skip 1/X/2 if their direct odds > 1.85 (regola assoluta)
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
        valid_markets.append(m)

    ranked = []
    for m in valid_markets:
        cov, covered, broken = coverage_for_market(m, central)
        frag = fragility_score(m, central)
        # Skip if coverage < 30%
        if cov < 0.30:
            continue
        # Score = coverage × (1 - fragility×0.3)
        score = cov * (1 - frag * 0.3)
        ranked.append({
            "market": m,
            "coverage": cov,
            "fragility": frag,
            "fragility_label": ("alta" if frag >= 0.45 else "media" if frag >= 0.25 else "bassa"),
            "covered_scores": covered[:6],
            "broken_by": broken[:5],
            "score": round(score, 4),
        })
    ranked.sort(key=lambda x: -x["score"])

    # Apply coherence filter: alternatives must be coherent with PICK
    pick = ranked[0]["market"] if ranked else ""
    coherent = ranked[:1] + filter_coherent(pick, ranked[1:])

    return {
        "structure": structure,
        "cluster": cluster,
        "central_cluster": central,
        "ranking": coherent[:6],
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

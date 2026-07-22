/**
 * Motore di Inferenza Strutturale Quote — porting TypeScript di cluster_engine.py
 * ================================================================================
 * Score Cluster Simulator (Poisson) + Market Coverage + Fragility + Family Classifier
 *
 * Porting 1:1 dalla versione Python originale (backend/cluster_engine.py).
 * Nessuna dipendenza esterna: solo Math nativo.
 */

export type Odds = Record<string, number | string[] | undefined>;

// ============================================================
// Poisson helpers
// ============================================================

function factorial(n: number): number {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function poisson(k: number, lam: number): number {
  if (lam <= 0) return k === 0 ? 1.0 : 0.0;
  return (Math.pow(lam, k) * Math.exp(-lam)) / factorial(k);
}

function impliedProb(odd: number | undefined | null): number {
  if (!odd || odd <= 1.0) return 0.0;
  return 1.0 / odd;
}

function num(odds: Odds, key: string): number {
  const v = odds[key];
  return typeof v === "number" ? v : 0;
}

// ============================================================
// derive_lambdas
// ============================================================

export function deriveLambdas(odds: Odds): [number, number] {
  const o25 = num(odds, "odd_O25") || num(odds, "odd_o25");
  const u25 = num(odds, "odd_U25") || num(odds, "odd_u25");

  let pOver25: number;
  if (o25 && u25) {
    const pO = impliedProb(o25);
    const pU = impliedProb(u25);
    const s = pO + pU;
    pOver25 = s > 0 ? pO / s : 0.5;
  } else {
    pOver25 = 0.5;
  }

  let lamTotal = 2.0 + (pOver25 - 0.3) * 3.5;
  lamTotal = Math.max(1.5, Math.min(4.5, lamTotal));

  const o1 = num(odds, "odd_1");
  const o2 = num(odds, "odd_2");
  const oX = num(odds, "odd_X");
  const p1 = impliedProb(o1);
  const p2 = impliedProb(o2);
  const pX = impliedProb(oX);
  const homeStrength = p1 + pX * 0.5;
  const awayStrength = p2 + pX * 0.5;
  const s = homeStrength + awayStrength || 1.0;
  let homeShare = homeStrength / s;
  let awayShare = awayStrength / s;

  const pGG = impliedProb(num(odds, "odd_GG"));
  const pNG = impliedProb(num(odds, "odd_NG"));
  if (pGG + pNG > 0) {
    const ggFactor = pGG / (pGG + pNG);
    if (ggFactor > 0.5) {
      const blend = (ggFactor - 0.5) * 0.5;
      homeShare = homeShare * (1 - blend) + 0.5 * blend;
      awayShare = 1.0 - homeShare;
    }
  }

  const lamHome = lamTotal * homeShare;
  const lamAway = lamTotal * awayShare;
  return [round3(lamHome), round3(lamAway)];
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ============================================================
// simulate_cluster
// ============================================================

export type ClusterEntry = {
  score: string;
  home: number;
  away: number;
  p: number;
  compatibility: "high" | "medium" | "low";
};

export function simulateCluster(odds: Odds, maxGoals = 6, topK = 12): ClusterEntry[] {
  const [lamH, lamA] = deriveLambdas(odds);
  const grid: [number, number, number][] = [];
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      grid.push([h, a, poisson(h, lamH) * poisson(a, lamA)]);
    }
  }
  const total = grid.reduce((s, g) => s + g[2], 0) || 1.0;
  const normalized = grid.map(([h, a, p]) => [h, a, p / total] as [number, number, number]);
  normalized.sort((x, y) => y[2] - x[2]);

  const out: ClusterEntry[] = [];
  for (const [h, a, p] of normalized.slice(0, topK)) {
    if (p < 0.005) break;
    const compatibility = p >= 0.1 ? "high" : p >= 0.06 ? "medium" : "low";
    out.push({ score: `${h}-${a}`, home: h, away: a, p: round4(p), compatibility });
  }
  return out;
}

// ============================================================
// evaluate_market_strict
// ============================================================

export function evaluateMarketStrict(market: string, home: number, away: number): boolean | null {
  const total = home + away;
  const m = market.trim().toUpperCase().replace(/ {2}/g, " ");
  if (m === "1") return home > away;
  if (m === "X") return home === away;
  if (m === "2") return away > home;
  if (m === "1X" || m === "DC 1X") return home >= away;
  if (m === "X2" || m === "DC X2") return away >= home;
  if (m === "12" || m === "DC 12") return home !== away;
  if (m === "GG") return home > 0 && away > 0;
  if (m === "NG") return home === 0 || away === 0;

  for (const o of ["0.5", "1.5", "2.5", "3.5", "4.5", "5.5"]) {
    if (m === `O${o}`) return total > parseFloat(o);
    if (m === `U${o}`) return total < parseFloat(o);
  }

  if (m.includes("MG")) {
    const rng = m.match(/(\d+)\s*-\s*(\d+)/);
    if (rng) {
      const lo = parseInt(rng[1], 10);
      const hi = parseInt(rng[2], 10);
      if (m.includes("CASA")) return lo <= home && home <= hi;
      if (m.includes("OSPITE")) return lo <= away && away <= hi;
      return lo <= total && total <= hi;
    }
  }

  if (market.includes("+")) {
    const parts = market.split("+").map((p) => p.trim());
    const results = parts.map((p) => evaluateMarketStrict(p, home, away));
    if (results.some((r) => r === null)) return null;
    return results.every((r) => r === true);
  }
  return null;
}

// ============================================================
// coverage_for_market / fragility_score
// ============================================================

export function coverageForMarket(
  market: string,
  cluster: ClusterEntry[]
): { coverage: number; covered: string[]; broken: string[] } {
  if (!cluster.length) return { coverage: 0, covered: [], broken: [] };
  const totalP = cluster.reduce((s, c) => s + c.p, 0) || 1.0;
  const covered: string[] = [];
  const broken: string[] = [];
  let covP = 0;
  for (const c of cluster) {
    const outcome = evaluateMarketStrict(market, c.home, c.away);
    if (outcome === true) {
      covered.push(c.score);
      covP += c.p;
    } else if (outcome === false) {
      broken.push(c.score);
    }
  }
  return { coverage: round4(covP / totalP), covered, broken };
}

export function fragilityScore(market: string, cluster: ClusterEntry[]): number {
  if (!cluster.length) return 0;
  const totalP = cluster.reduce((s, c) => s + c.p, 0) || 1.0;
  let failP = 0;
  for (const c of cluster) {
    if (evaluateMarketStrict(market, c.home, c.away) === false) failP += c.p;
  }
  return round4(failP / totalP);
}

// ============================================================
// classify_family
// ============================================================

export type FamilyStructure = {
  family: string;
  dominance: string;
  offensive_profile: string;
  goal_compression: "high" | "medium" | "low";
  goal_floor: number;
  goal_ceiling: number;
  goal_ceiling_open: boolean;
  goal_range: string;
  lambda_home: number;
  lambda_away: number;
};

export function classifyFamily(odds: Odds): FamilyStructure {
  const o1 = num(odds, "odd_1") || 99;
  const o2 = num(odds, "odd_2") || 99;
  const oGG = num(odds, "odd_GG") || 99;
  const oNG = num(odds, "odd_NG") || 99;
  const oO15 = num(odds, "odd_O15") || 99;
  const oU15 = num(odds, "odd_U15") || 99;
  const oO25 = num(odds, "odd_O25") || 99;
  const oU25 = num(odds, "odd_U25") || 99;
  const oU35 = num(odds, "odd_U35") || 99;
  const oO35 = num(odds, "odd_O35") || 99;

  let dominance: string;
  if (o1 <= 1.5) dominance = "strong_home";
  else if (o1 <= 1.85) dominance = "light_home";
  else if (o2 <= 1.5) dominance = "strong_away";
  else if (o2 <= 1.85) dominance = "light_away";
  else dominance = "none";

  let offensiveProfile: string;
  if (oGG <= 1.65) offensiveProfile = "reciprocity_high";
  else if (oGG <= 1.85) offensiveProfile = "moderate";
  else if (oNG <= 1.7) offensiveProfile = "defensive";
  else offensiveProfile = "neutral";

  // GOAL FLOOR
  let goalFloor: number;
  if (oO15 <= 1.2 && oU15 >= 4.0) goalFloor = 2;
  else if (oO15 <= 1.3 && oU15 >= 3.0) goalFloor = 2;
  else goalFloor = 0;

  // GOAL CEILING
  let goalCeiling: number;
  let goalCeilingOpen: boolean;
  if (oU25 <= 1.4) {
    goalCeiling = 2;
    goalCeilingOpen = false;
  } else if (oU35 <= 1.15) {
    goalCeiling = 3;
    goalCeilingOpen = false;
  } else if (oU35 <= 1.4 && oO35 >= 3.0) {
    goalCeiling = 4;
    goalCeilingOpen = false;
  } else if (oU35 <= 1.85 && oO35 >= 2.5) {
    goalCeiling = 4;
    goalCeilingOpen = false;
  } else if (oU35 <= 1.85 && oO35 >= 2.2) {
    goalCeiling = 7;
    goalCeilingOpen = true;
  } else {
    goalCeiling = 7;
    goalCeilingOpen = true;
  }

  const goalCompression: "high" | "medium" | "low" =
    oU35 <= 1.4 && oO35 >= 2.8 ? "high" : oU35 <= 1.7 ? "medium" : "low";

  const extremeFav = o1 <= 1.35 || o2 <= 1.35;
  const hasFavorite = o1 <= 1.85 || o2 <= 1.85;
  const isOffensive = oO25 <= 1.85 || oGG <= 1.85;
  const isClosed = oU25 <= 1.7 || oNG <= 1.7;

  let family: string;
  if (goalCeilingOpen && hasFavorite) family = "DOMINANZA_OVER";
  else if (goalCeilingOpen && isOffensive) family = "EQUILIBRATA_OFFENSIVA";
  else if (!hasFavorite && isOffensive && goalCeiling <= 4) family = "EQUILIBRATA_OFFENSIVA";
  else if (!hasFavorite && isClosed) family = "EQUILIBRATA_CHIUSA";
  else if (extremeFav && oNG <= 1.95 && oU35 <= 1.65) family = "DOMINANZA_CHIUSA";
  else if (hasFavorite && goalCeiling <= 4 && !goalCeilingOpen) family = "DOMINANZA_CON_TETTO";
  else if (hasFavorite && oO25 <= 1.65) family = "DOMINANZA_OVER";
  else if (goalCeiling <= 2) family = "BLOCCATA";
  else family = "INSTABILE";

  const [lamHome, lamAway] = deriveLambdas(odds);

  return {
    family,
    dominance,
    offensive_profile: offensiveProfile,
    goal_compression: goalCompression,
    goal_floor: goalFloor,
    goal_ceiling: goalCeiling,
    goal_ceiling_open: goalCeilingOpen,
    goal_range: `${goalFloor}-${goalCeilingOpen ? "∞" : goalCeiling}`,
    lambda_home: lamHome,
    lambda_away: lamAway,
  };
}

// ============================================================
// Coherence filter
// ============================================================

const INCOHERENCE_PAIRS: [string, string][] = [
  ["1", "2"], ["1", "X"], ["1", "X2"],
  ["2", "X"], ["2", "1X"],
  ["1X", "X2"],
  ["GG", "NG"],
  ["O1.5", "U1.5"], ["O2.5", "U2.5"], ["O3.5", "U3.5"],
  ["O2.5", "U3.5"], ["O1.5", "U2.5"],
];

function normMarket(m: string): string {
  return (m || "").trim().toUpperCase().replace(/DC /g, "").replace(/ {2}/g, " ");
}

export function areIncoherent(a: string, b: string): boolean {
  const na = normMarket(a);
  const nb = normMarket(b);
  if (na === nb) return false;
  for (const [x, y] of INCOHERENCE_PAIRS) {
    if ((na.includes(x) && nb.includes(y)) || (na.includes(y) && nb.includes(x))) {
      if ((na.startsWith(x) && nb.startsWith(y)) || (na.startsWith(y) && nb.startsWith(x))) {
        return true;
      }
    }
  }
  if (na.includes("+") && nb.includes("+")) {
    if ((na.includes("O") && nb.includes("U")) || (na.includes("U") && nb.includes("O"))) {
      return true;
    }
  }
  return false;
}

export function filterCoherent<T extends { market?: string }>(pick: string, candidates: T[]): T[] {
  return candidates.filter((c) => !areIncoherent(pick, c.market || ""));
}

// ============================================================
// Candidate markets
// ============================================================

export const CANDIDATE_MARKETS: string[] = [
  "1", "X", "2", "1X", "X2", "12",
  "O1.5", "U1.5", "O2.5", "U2.5", "O3.5", "U3.5",
  "GG", "NG",
  "MG 1-2 totali", "MG 1-3 totali", "MG 1-4 totali",
  "MG 2-3 totali", "MG 2-4 totali", "MG 2-5 totali",
  "MG 3-4 totali", "MG 3-5 totali",
  "MG 1-2 casa", "MG 1-3 casa", "MG 2-3 casa", "MG 2-4 casa",
  "MG 1-2 ospite", "MG 1-3 ospite", "MG 2-3 ospite", "MG 2-4 ospite",
  "1 + O1.5", "2 + O1.5", "1 + O2.5", "2 + O2.5",
  "1 + U4.5", "2 + U4.5",
  "GG + O2.5",
  "DC 1X + O1.5", "DC X2 + O1.5", "DC 12 + O1.5",
  "DC 1X + O2.5", "DC X2 + O2.5", "DC 12 + O2.5",
  "DC 1X + U3.5", "DC X2 + U3.5", "DC 12 + U3.5",
  "DC 1X + GG", "DC X2 + GG", "DC 12 + GG",
];

// ============================================================
// combo odd estimation
// ============================================================

function estimateComboOddFromCluster(market: string, odds: Odds): number | null {
  try {
    const [lamH, lamA] = deriveLambdas(odds);
    const maxGoals = 8;
    let totalP = 0;
    let matchP = 0;
    for (let h = 0; h <= maxGoals; h++) {
      for (let a = 0; a <= maxGoals; a++) {
        const p = poisson(h, lamH) * poisson(a, lamA);
        totalP += p;
        if (evaluateMarketStrict(market, h, a) === true) matchP += p;
      }
    }
    if (totalP <= 0 || matchP <= 0) return null;
    const prob = matchP / totalP;
    const p1 = impliedProb(num(odds, "odd_1"));
    const px = impliedProb(num(odds, "odd_X"));
    const p2 = impliedProb(num(odds, "odd_2"));
    let overround = p1 && px && p2 ? p1 + px + p2 : 1.06;
    if (overround <= 0) overround = 1.06;
    const fairOdd = 1.0 / prob;
    const est = fairOdd / overround;
    return est >= 1.01 ? round2(est) : null;
  } catch {
    return null;
  }
}

const ODD_MAP: Record<string, string> = {
  "1": "odd_1", X: "odd_X", "2": "odd_2",
  "1X": "odd_1X", X2: "odd_X2", "12": "odd_12",
  "O1.5": "odd_O15", "U1.5": "odd_U15",
  "O2.5": "odd_O25", "U2.5": "odd_U25",
  "O3.5": "odd_O35", "U3.5": "odd_U35",
  GG: "odd_GG", NG: "odd_NG",
};

export function comboOdd(market: string, odds: Odds): number | null {
  const m = market.trim().toUpperCase().replace(/DC /g, "").replace(/ {2}/g, " ");
  if (ODD_MAP[m]) {
    const v = num(odds, ODD_MAP[m]);
    return v || null;
  }
  if (m.includes("+")) {
    const parts = m.split("+").map((p) => p.trim());
    const vals = parts.map((p) => num(odds, ODD_MAP[p] || ""));
    if (vals.every((v) => v && v > 0)) {
      return round3(vals[0] * vals[1]);
    }
    const est = estimateComboOddFromCluster(market, odds);
    if (est) return est;
  }
  return null;
}

// ============================================================
// structural_analysis — main entry
// ============================================================

export type MlScoreEntry = { win_rate: number; total: number; wins?: number; losses?: number };

export type RankedMarket = {
  market: string;
  coverage: number;
  fragility: number;
  fragility_label: "alta" | "media" | "bassa";
  covered_scores: string[];
  broken_by: string[];
  score: number;
  odd: number | null;
  ml_adjustment?: { type: "boost" | "malus" | "neutral"; win_rate: number; total: number; delta: string };
};

export type StructuralAnalysisResult = {
  structure: FamilyStructure;
  cluster: ClusterEntry[];
  central_cluster: ClusterEntry[];
  ranking: RankedMarket[];
  pick: RankedMarket | null;
  explanation: string;
};

export function structuralAnalysis(
  odds: Odds,
  minOdd = 1.4,
  mlScores?: Record<string, MlScoreEntry> | null
): StructuralAnalysisResult {
  const structure = classifyFamily(odds);
  const cluster = simulateCluster(odds, 6, 12);
  const central = cluster.slice(0, 8);
  const lamH = structure.lambda_home;
  const lamA = structure.lambda_away;
  const lamMin = Math.min(lamH, lamA);
  const lamMax = Math.max(lamH, lamA);

  // --- basic odds-rule filter ---
  let validMarkets: string[] = [];
  for (const m of CANDIDATE_MARKETS) {
    if (m === "1" && (num(odds, "odd_1") || 99) > 1.85) continue;
    if (m === "2" && (num(odds, "odd_2") || 99) > 1.85) continue;
    if (m === "X" && (num(odds, "odd_X") || 99) > 3.5) continue;
    if (m === "1X" && (num(odds, "odd_1X") || 99) > 1.85) continue;
    if (m === "X2" && (num(odds, "odd_X2") || 99) > 1.85) continue;
    if (m === "12" && (num(odds, "odd_12") || 99) > 1.85) continue;
    if (m === "1 + O1.5" && (num(odds, "odd_1") || 99) > 1.85) continue;
    if (m === "2 + O1.5" && (num(odds, "odd_2") || 99) > 1.85) continue;
    const co = comboOdd(m, odds);
    if (co !== null && co < minOdd) continue;
    validMarkets.push(m);
  }

  const floor = structure.goal_floor;
  const ceiling = structure.goal_ceiling;
  const ceilingOpen = structure.goal_ceiling_open;

  // NOTE: `mu` is intentionally declared ONCE at function scope and reused
  // (not re-declared per market) to faithfully replicate a real quirk present
  // in the original Python engine: in the scoring loop below, the
  // "dominanza+tetto" boost reads `mu` BEFORE it's refreshed for the current
  // market, so it can carry over the previous market's value. This is kept
  // deliberately (Opzione A) so migrated predictions match production exactly.
  let mu = "";

  // --- structural floor/ceiling exclusions ---
  const filtered: string[] = [];
  for (const m of validMarkets) {
    mu = m.toUpperCase().trim();

    if (mu === "U0.5") continue;
    if (mu === "U1.5" && floor >= 1) continue;
    if (mu === "U2.5" && floor >= 2) continue;
    if (mu === "U3.5" && floor >= 2) continue;

    if (floor >= 2) {
      if (mu === "O1.5") continue;
      if (mu.includes("+ O1.5")) continue;
      if (mu === "1 + O1.5" || mu === "2 + O1.5") continue;
    }
    if (floor >= 3) {
      if (mu === "O2.5") continue;
      if (mu.includes("+ O2.5")) continue;
    }

    if (mu.includes("MG") && mu.includes("TOTALI")) {
      const rng = m.match(/(\d+)\s*-\s*(\d+)/);
      if (rng && parseInt(rng[1], 10) < floor) continue;
    }
    if (mu.startsWith("DC ") && mu.includes("+ U1.5") && floor >= 1) continue;
    if (mu.startsWith("DC ") && mu.includes("+ U2.5") && floor >= 2) continue;

    const odd1 = num(odds, "odd_1") || 99;
    const odd2 = num(odds, "odd_2") || 99;
    if (mu === "1 + U4.5") {
      if (ceilingOpen || ceiling > 4) continue;
      if (odd1 >= 1.4) continue;
    } else if (mu === "2 + U4.5") {
      if (ceilingOpen || ceiling > 4) continue;
      if (odd2 >= 1.4) continue;
    }

    if (!ceilingOpen) {
      if (mu === "O3.5" && ceiling <= 3) continue;
      if (mu === "O2.5" && ceiling <= 3) continue;
      if (mu === "O1.5" && ceiling <= 2) continue;
      if (ceiling <= 3) {
        if (mu === "U3.5") continue;
        if (mu.includes("+ U3.5")) continue;
      }
      if (ceiling <= 2) {
        if (mu === "U2.5") continue;
        if (mu.includes("+ U2.5")) continue;
      }
      if (mu.includes("MG") && mu.includes("TOTALI")) {
        const rng = m.match(/(\d+)\s*-\s*(\d+)/);
        if (rng && parseInt(rng[2], 10) > ceiling) continue;
      }
      if (mu.includes("+ O3.5") && ceiling <= 3) continue;
      if (mu.includes("+ O2.5") && ceiling <= 3) continue;
      if (mu.includes("+ O1.5") && ceiling <= 2) continue;
      if ((mu === "1 + O1.5" || mu === "2 + O1.5") && ceiling <= 2) continue;
    }

    filtered.push(m);
  }
  validMarkets = filtered;

  const ranked: RankedMarket[] = [];
  for (const m of validMarkets) {
    const { coverage: cov, covered, broken } = coverageForMarket(m, central);
    const frag = fragilityScore(m, central);
    if (cov < 0.3) continue;

    let score = cov * (1 - frag * 0.3);
    const rng = m.match(/(\d+)\s*-\s*(\d+)/);

    // --- MG "perfetto" boost/penalty ---
    if (m.toUpperCase().includes("MG") && rng) {
      const lo = parseInt(rng[1], 10);
      const hi = parseInt(rng[2], 10);
      const span = hi - lo;
      const MU = m.toUpperCase();
      const isTotali = MU.includes("TOTALI");
      const isCasa = MU.includes("CASA");
      const isOspite = MU.includes("OSPITE");

      if (isTotali) {
        if (lo === floor && hi === ceiling) score *= 1.3;
        else if (Math.abs(lo - floor) <= 1 && Math.abs(hi - ceiling) <= 1) score *= 1.1;
        if (lo < floor) score *= 0.55;
      } else if (isCasa) {
        const lam = lamH;
        if (lo === 1 && lam >= 2.0) score *= 0.45;
        else if (lo === 1 && lam >= 1.6 && floor >= 2) score *= 0.65;
        else if (lo <= lam && lam <= hi && span <= 3) score *= 1.25;
        else if (lo > 0 && span <= 3) score *= 1.05;
      } else if (isOspite) {
        const lam = lamA;
        if (lo === 1 && lam >= 2.0) score *= 0.45;
        else if (lo === 1 && lam >= 1.6 && floor >= 2) score *= 0.65;
        else if (lo <= lam && lam <= hi && span <= 3) score *= 1.25;
        else if (lo > 0 && span <= 3) score *= 1.05;
      }

      if (isTotali) {
        if (span >= 4 && cov >= 0.85) score *= 0.55;
        else if (span >= 3 && cov >= 0.9) score *= 0.7;
      }
    }

    // --- dominanza+tetto combo boost --- (reads mu BEFORE it's refreshed below — intentional, see note above)
    if (mu === "1 + U4.5" && lamH >= lamA + 0.8) score *= 1.35;
    else if (mu === "2 + U4.5" && lamA >= lamH + 0.8) score *= 1.35;
    else if (mu === "1 + U4.5" && lamH - lamA < 0.3) score *= 0.55;
    else if (mu === "2 + U4.5" && lamA - lamH < 0.3) score *= 0.55;

    // --- mercati secchi boost ---
    const lamTot = lamH + lamA;
    mu = m.toUpperCase().replace(/ {2}/g, " ");
    if (mu === "O2.5" && lamTot >= 2.8) score *= 1.3;
    else if (mu === "O1.5" && lamH >= 0.9 && lamA >= 0.9) score *= 1.2;
    else if (mu === "GG" && lamH >= 1.2 && lamA >= 1.2) score *= 1.25;
    else if (mu === "NG" && Math.min(lamH, lamA) <= 0.75) score *= 1.05;

    const LAMBDA_GAP_DIR = 0.3;
    const lambdaGap = Math.abs(lamH - lamA);
    const isBalanced = lambdaGap < LAMBDA_GAP_DIR;
    if (mu === "1X") {
      if (lamH - lamA >= LAMBDA_GAP_DIR) score *= 1.2;
      else if (isBalanced) score *= 0.5;
    } else if (mu === "X2") {
      if (lamA - lamH >= LAMBDA_GAP_DIR) score *= 1.2;
      else if (isBalanced) score *= 0.5;
    } else if (mu === "12" && isBalanced && lamMax < 2.2) {
      score *= 0.45;
    } else if (
      ["DC 1X + O1.5", "DC X2 + O1.5", "DC 1X + O2.5", "DC X2 + O2.5", "DC 1X + GG", "DC X2 + GG", "DC 1X + U3.5", "DC X2 + U3.5"].includes(mu) &&
      isBalanced
    ) {
      score *= 0.65;
    }

    // --- extreme lambda gap boosts ---
    const isExtreme = lamMin <= 0.7 && lamMax >= 2.2;
    if (isExtreme) {
      mu = m.toUpperCase().replace(/ {2}/g, " ");
      if (mu === "NG") score *= 1.05;
      if (lamA >= lamH && (mu === "2 + O1.5" || mu === "DC X2 + O1.5")) score *= 1.25;
      if (lamH >= lamA && (mu === "1 + O1.5" || mu === "DC 1X + O1.5")) score *= 1.25;
      if (lamA >= lamH && (mu === "2 + O2.5" || mu === "DC X2 + O2.5")) score *= 1.3;
      if (lamH >= lamA && (mu === "1 + O2.5" || mu === "DC 1X + O2.5")) score *= 1.3;
      const lamTot2 = lamH + lamA;
      if (mu === "O2.5" && lamTot2 >= 2.8) score *= 1.2;
      if (lamH >= lamA && mu === "1 + U4.5") score *= 1.3;
      if (lamA >= lamH && mu === "2 + U4.5") score *= 1.3;
      if (mu === "U3.5") score *= 0.8;
      if (mu.includes("MG 2-4 CASA") && lamH < 1.0) score *= 0.5;
      if (mu.includes("MG 2-4 OSPITE") && lamA < 1.0) score *= 0.5;
    }

    // --- open ceiling adjustments ---
    if (ceilingOpen) {
      const muOpen = m.toUpperCase();
      if (muOpen === "U3.5" || muOpen === "U2.5") score *= 0.55;
      if (muOpen.includes("MG") && muOpen.includes("TOTALI")) {
        const rngO = m.match(/(\d+)\s*-\s*(\d+)/);
        if (rngO) {
          const hiO = parseInt(rngO[2], 10);
          if (hiO <= 4) score *= 0.65;
          else if (hiO === 5) score *= 0.85;
        }
      }
      if (muOpen.includes("MG 2-3") || muOpen.includes("MG 1-3")) score *= 0.7;
      if (m.includes("+ U3.5") || m.includes("+ U2.5")) score *= 0.65;
      if (["O2.5", "O3.5", "GG"].includes(muOpen)) score *= 1.3;
      if (m.includes("+ O2.5") || m.includes("+ O1.5")) score *= 1.25;
      if (muOpen.includes("MG") && muOpen.includes("TOTALI")) {
        const rngO2 = m.match(/(\d+)\s*-\s*(\d+)/);
        if (rngO2) {
          const hiO2 = parseInt(rngO2[2], 10);
          if (hiO2 >= 6) score *= 1.2;
        }
      }
    }

    ranked.push({
      market: m,
      coverage: cov,
      fragility: frag,
      fragility_label: frag >= 0.45 ? "alta" : frag >= 0.25 ? "media" : "bassa",
      covered_scores: covered.slice(0, 6),
      broken_by: broken.slice(0, 5),
      score: round4(score),
      odd: comboOdd(m, odds),
    });
  }

  // --- ML boost ---
  if (mlScores) {
    for (const r of ranked) {
      const sc = mlScores[r.market];
      if (!sc) continue;
      const total = sc.total || 0;
      const wr = sc.win_rate || 0;
      if (total < 10) continue;
      if (wr >= 70) {
        r.score = round4(r.score * 1.1);
        r.ml_adjustment = { type: "boost", win_rate: wr, total, delta: "+10%" };
      } else if (wr <= 30) {
        r.score = round4(r.score * 0.9);
        r.ml_adjustment = { type: "malus", win_rate: wr, total, delta: "-10%" };
      } else {
        r.ml_adjustment = { type: "neutral", win_rate: wr, total, delta: "0%" };
      }
    }
  }

  ranked.sort((a, b) => b.score - a.score);

  const pickMarket = ranked.length ? ranked[0].market : "";
  const coherent = ranked.length ? [ranked[0], ...filterCoherent(pickMarket, ranked.slice(1))] : [];

  return {
    structure,
    cluster,
    central_cluster: central,
    ranking: coherent.slice(0, 10),
    pick: ranked.length ? ranked[0] : null,
    explanation: buildExplanation(structure, coherent),
  };
}

function buildExplanation(structure: FamilyStructure, ranking: RankedMarket[]): string {
  if (!ranking.length) return "Nessun mercato con coverage sufficiente.";
  const p = ranking[0];
  const fam = structure.family;
  const floor = structure.goal_floor;
  const ceil = structure.goal_ceiling;
  const pick = p.market;
  const cov = Math.round(p.coverage * 100);
  return (
    `Famiglia ${fam}. Pavimento ${floor} · Tetto ${ceil} · Range ${floor}-${ceil}. ` +
    `PICK: ${pick} con coverage ${cov}% sul cluster centrale. ` +
    `Fragility ${p.fragility_label} (${Math.round(p.fragility * 100)}% del cluster lo batte).`
  );
}

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL || "";

export type OddsKey =
  | "odd_1" | "odd_X" | "odd_2"
  | "odd_1X" | "odd_X2" | "odd_12"
  | "odd_U15" | "odd_O15"
  | "odd_U25" | "odd_O25"
  | "odd_U35" | "odd_O35"
  | "odd_GG" | "odd_NG";

export type Odds = Partial<Record<OddsKey, number>> & { estimated?: OddsKey[] };

export type Match = {
  id: string;
  day: string;
  time: string;
  manifestazione: string;
  squadra1: string;
  squadra2: string;
  odds: Odds;
  result?: string | null;
  family?: string | null;
  main_prediction?: string | null;
  playable_markets?: { market: string; reasoning?: string }[] | null;
  selected?: boolean;
};

export type Prediction = {
  id?: string;
  match_id: string;
  family?: string;
  analysis?: string;
  playable_markets?: { market: string; reasoning: string }[];
  main_prediction?: string;
  confidence?: string;
  min_goals?: number;
  max_goals?: number;
};

export type StructuralCluster = {
  score: string;
  home: number;
  away: number;
  p: number;
  compatibility: "high" | "medium" | "low";
};

export type MLAdjustment = {
  type: "boost" | "malus" | "neutral";
  win_rate: number;
  total: number;
  delta: string;  // e.g. "+10%", "-10%", "0%"
};

export type StructuralMarketRank = {
  market: string;
  coverage: number;
  fragility: number;
  fragility_label: "bassa" | "media" | "alta";
  covered_scores: string[];
  broken_by: string[];
  score: number;
  ml_adjustment?: MLAdjustment;
};

export type StructuralStructure = {
  family: string;
  dominance: string;
  offensive_profile: string;
  goal_compression: "high" | "medium" | "low";
  goal_floor: number;
  goal_ceiling: number;
  goal_ceiling_open?: boolean;
  goal_range: string;
  lambda_home: number;
  lambda_away: number;
};

export type StructuralAnalysis = {
  structure: StructuralStructure;
  cluster: StructuralCluster[];
  central_cluster: StructuralCluster[];
  ranking: StructuralMarketRank[];
  pick: StructuralMarketRank | null;
  explanation: string;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${res.status} ${t}`);
  }
  return res.json();
}

export const api = {
  base: BASE,
  matches: (day?: string, q?: string) => {
    const p = new URLSearchParams();
    if (day) p.set("day", day);
    if (q) p.set("q", q);
    const qs = p.toString();
    return req<Match[]>(`/matches${qs ? `?${qs}` : ""}`);
  },
  days: () => req<string[]>("/matches/days"),
  match: (id: string) => req<Match & { prediction?: Prediction }>(`/matches/${id}`),
  predict: (id: string, force?: boolean) =>
    req<Prediction>(`/matches/${id}/predict${force ? "?force=true" : ""}`, { method: "POST" }),
  setResult: (id: string, result: string) =>
    req<{ ok: boolean; learning?: { applied: boolean; main_prediction?: string; result_ok?: boolean } }>(`/matches/${id}/result`, {
      method: "POST",
      body: JSON.stringify({ result }),
    }),
  bulkResults: (items: { id: string; result: string }[]) =>
    req<{ updated: number; learnings?: any[] }>(`/results/bulk`, {
      method: "POST",
      body: JSON.stringify({ items }),
    }),
  statsScores: () => req<Record<string, any[]>>("/stats/scores"),
  statsReset: () => req<{ ok: boolean }>("/stats/reset", { method: "POST" }),
  updateSelection: (ids: string[], selected: boolean) =>
    req<{ ok: boolean }>(`/matches/selection`, {
      method: "POST",
      body: JSON.stringify({ ids, selected }),
    }),
  selectedList: () => req<Match[]>("/matches/selected/list"),
  clearSelection: () => req<{ ok: boolean }>(`/selection/clear`, { method: "POST" }),
  exportDb: () => req<any>("/export"),
  importDb: (payload: any) =>
    req<any>(`/import`, { method: "POST", body: JSON.stringify(payload) }),
  deleteAll: () => req<{ ok: boolean }>(`/matches/all`, { method: "DELETE" }),
  aiStudioPrompt: () => req<{ csv: string; count: number }>(`/aistudio/prompt`),
  getLlmSettings: () => req<{ options: any[]; selected_id: string }>("/settings/llm"),
  setLlmSettings: (id: string) => req<{ ok: boolean; selected_id: string }>("/settings/llm", { method: "POST", body: JSON.stringify({ id }) }),
  getBudget: () => req<{ estimated_spent_usd: number; predictions_made: number; current_model: string; cost_per_prediction_usd: number; topup_url: string }>("/settings/budget"),
  resetBudget: () => req<{ ok: boolean }>("/settings/budget/reset", { method: "POST" }),
  marketStats: () => req<{ markets: { family: string; market: string; wins: number; losses: number; total: number; missed: number; family_total: number; miss_rate: number; win_rate: number }[]; family_totals: Record<string, number> }>("/ml/stats"),
  fetchResultsAuto: (ids: string[], apply = true, apply_threshold = 80) => req<{ results: any[]; applied: number; not_found: number; skipped: number }>("/results/fetch", { method: "POST", body: JSON.stringify({ ids, apply, apply_threshold }) }),
  applyResultManual: (id: string, score: string) => req<{ ok: boolean; result: string }>("/results/apply", { method: "POST", body: JSON.stringify({ id, score }) }),
  matchCandidates: (id: string) => req<{ candidates: { market: string; family: string; missed: number; family_total: number; miss_rate: number }[]; family: string | null; family_total: number }>(`/match/${id}/candidates`),
  matchHistory: (id: string) => req<{ league: string; global: Record<string, any[]>; league_specific: Record<string, any[]> }>(`/match/${id}/history`),
  matchStructural: (id: string) => req<StructuralAnalysis>(`/match/${id}/structural`),
  uploadExcel: async (uri: string, name: string, mimeType?: string) => {
    const form = new FormData();
    if (typeof window !== "undefined" && window.fetch && uri.startsWith("blob:")) {
      // Web: fetch the blob URL and append as Blob
      const r = await fetch(uri);
      const blob = await r.blob();
      form.append("file", blob, name);
    } else if (typeof window !== "undefined" && uri.startsWith("data:")) {
      // Web data: URI
      const r = await fetch(uri);
      const blob = await r.blob();
      form.append("file", blob, name);
    } else {
      // Native (iOS/Android): use uri reference
      // @ts-ignore - RN FormData file shape
      form.append("file", { uri, name, type: mimeType || "application/octet-stream" });
    }
    const res = await fetch(`${BASE}/api/upload-excel`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json() as Promise<{ inserted: number; updated: number; unchanged?: number; skipped: number; total_parsed: number; rows_seen?: number }>;
  },
  uploadSkipped: () => req<UploadSkippedReport>(`/upload/skipped`),
};

export type SkippedRow = {
  row: number;
  time?: string;
  sq1?: string;
  sq2?: string;
  manif?: string;
  reason: string;
  odds_read?: Partial<Record<OddsKey, number>>;
  missing?: OddsKey[];
};

export type UploadSkippedReport = {
  filename: string | null;
  uploaded_at: string | null;
  rows_seen: number;
  valid_matches: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped_count: number;
  skipped: SkippedRow[];
};

export const ODD_LABELS: Record<OddsKey, string> = {
  odd_1: "1",
  odd_X: "X",
  odd_2: "2",
  odd_1X: "1X",
  odd_X2: "X2",
  odd_12: "12",
  odd_U15: "U1.5",
  odd_O15: "O1.5",
  odd_U25: "U2.5",
  odd_O25: "O2.5",
  odd_U35: "U3.5",
  odd_O35: "O3.5",
  odd_GG: "GG",
  odd_NG: "NG",
};

export const MARKET_FAMILIES: { name: string; keys: OddsKey[] }[] = [
  { name: "Esito Finale", keys: ["odd_1", "odd_X", "odd_2"] },
  { name: "Doppia Chance", keys: ["odd_1X", "odd_X2", "odd_12"] },
  { name: "Under/Over 1.5", keys: ["odd_U15", "odd_O15"] },
  { name: "Under/Over 2.5", keys: ["odd_U25", "odd_O25"] },
  { name: "Under/Over 3.5", keys: ["odd_U35", "odd_O35"] },
  { name: "Goal/NoGoal", keys: ["odd_GG", "odd_NG"] },
];

export type Candidate = { market: string; odd: number; family: string };

/**
 * Generate a FAMILY of pre-prediction candidates (multiple markets, not just one),
 * applying the rules:
 *  - "1" valido solo se odd_1 ≤ 1.85
 *  - "2" valido solo se odd_2 ≤ 1.85
 *  - "X"/"1X"/"X2"/"12" disponibili solo se almeno una tra 1 e 2 è ≤ 1.85 (favorita esistente)
 *  - Mercati con quota < 1.40 vengono ESCLUSI (non credibili / payout troppo basso)
 *  - Mercati con quota > 2.00 considerati "poco credibili" e ricevono priorità minore
 */
export function quickPredictionFamily(odds: Odds): Candidate[] {
  const o = odds || {};
  const get = (k: OddsKey, def = Infinity) => (o[k] ?? def) as number;
  const o1 = get("odd_1"), oX = get("odd_X"), o2 = get("odd_2");
  const o1X = get("odd_1X"), oX2 = get("odd_X2"), o12 = get("odd_12");
  const oO15 = get("odd_O15");
  const oO25 = get("odd_O25"), oU25 = get("odd_U25");
  const oO35 = get("odd_O35"), oU35 = get("odd_U35");
  const oGG = get("odd_GG"), oNG = get("odd_NG");

  const out: Candidate[] = [];
  const push = (market: string, odd: number, family: string) => {
    if (!isFinite(odd)) return;
    // Filtro: scarta quote < 1.40 (non credibili come puntata)
    if (odd < 1.40) return;
    // Evita duplicati
    if (out.find((c) => c.market === market)) return;
    out.push({ market, odd, family });
  };

  // ============================================================
  // 1X2 family — applichiamo la regola 1.85
  // ============================================================
  const oneValid = o1 <= 1.85;
  const twoValid = o2 <= 1.85;
  const hasFavorita = oneValid || twoValid; // se nessuna favorita, blocco tutto 1X2

  if (oneValid) push("1", o1, "DOMINANZA");
  if (twoValid) push("2", o2, "DOMINANZA");
  if (hasFavorita) {
    if (oneValid && o1X <= 1.60) push("1X", o1X, "DOMINANZA_TETTO");
    if (twoValid && oX2 <= 1.60) push("X2", oX2, "DOMINANZA_TETTO");
    if (o12 <= 1.40) push("12", o12, "ANTI_X"); // raro, solo equilibri
  }

  // ============================================================
  // GOL family
  // ============================================================
  // RANGE_CONTROLLATO: pavimento + tetto
  if (oO15 <= 1.40 && oU35 <= 1.40) {
    push("MG 2-4 totali", Math.max(1.40, (oO15 + oU35) / 2), "RANGE_CONTROLLATO");
  }
  // NOTE: "GG + O1.5" rimosso perché ridondante: GG ⇒ O1.5 (entrambe segnano ≥1 → totale ≥2)
  // O2.5 secco
  if (oO25 <= 1.85) push("O2.5", oO25, "OFFENSIVA");
  // GG secco
  if (oGG <= 1.85) push("GG", oGG, "OFFENSIVA");
  // O1.5
  if (oO15 <= 1.50) push("O1.5", oO15, "RANGE_CONTROLLATO");
  // O3.5 alto-rendimento
  if (oO35 <= 1.85) push("O3.5", oO35, "OFFENSIVA_PULITA");

  // ============================================================
  // UNDER / NoGoal family
  // ============================================================
  if (oU25 <= 1.85) push("U2.5", oU25, "CHIUSA_PROTETTA");
  if (oU35 <= 1.40) push("U3.5", oU35, "CHIUSA_PROTETTA");
  if (oNG <= 1.85) push("NG", oNG, "CHIUSA_PROTETTA");

  // ============================================================
  // DC + OVER/UNDER combos quando applicabili
  // ============================================================
  if (hasFavorita) {
    if (oneValid && oO15 <= 1.50) push("DC 1X + O1.5", Math.max(o1X, oO15), "DOMINANZA_GOL");
    if (twoValid && oO15 <= 1.50) push("DC X2 + O1.5", Math.max(oX2, oO15), "DOMINANZA_GOL");
    if (oneValid && oU35 <= 1.40) push("DC 1X + U3.5", Math.max(o1X, oU35), "DOMINANZA_TETTO");
    if (twoValid && oU35 <= 1.40) push("DC X2 + U3.5", Math.max(oX2, oU35), "DOMINANZA_TETTO");
  }

  // Ordinamento default: dalla quota più bassa (più sicura) alla più alta
  out.sort((a, b) => a.odd - b.odd);
  return out;
}

/**
 * Backward-compatible single-market pre-prediction (returns the TOP candidate).
 */
export function quickPrediction(odds: Odds): Candidate | null {
  const fam = quickPredictionFamily(odds);
  return fam[0] || null;
}

/**
 * Normalize market labels so concordance matching is reliable.
 * "Ov2.5", "Over 2.5", "O2.5" all map to "O2.5"
 */
export function normalizeMarket(m: string): string {
  if (!m) return "";
  return m.trim()
    .replace(/Over\s*/i, "O")
    .replace(/Under\s*/i, "U")
    .replace(/Ov(\d)/i, "O$1")
    .replace(/Un(\d)/i, "U$1")
    .replace(/\bGoal\b/i, "GG")
    .replace(/\bNo\s?Goal\b/i, "NG")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check if two markets are DISCORDANT (impossible to both win on the same match).
 * Returns true if discordant, false otherwise.
 */
export function areDiscordant(a: string, b: string): boolean {
  const na = normalizeMarket(a);
  const nb = normalizeMarket(b);
  if (na === nb) return false;
  const PAIRS: [RegExp, RegExp][] = [
    [/^1$/, /^2$/], [/^1$/, /^X$/], [/^1$/, /^X2$/],
    [/^2$/, /^X$/], [/^2$/, /^1X$/],
    [/^1X$/, /^X2$/],   // technically both can win if X
    [/^GG$/, /^NG$/],
    [/^O1\.5$/, /^U1\.5$/], [/^O2\.5$/, /^U2\.5$/], [/^O3\.5$/, /^U3\.5$/],
    [/MG 2-4.*CASA/, /MG 2-4.*OSPITE/],
  ];
  for (const [p1, p2] of PAIRS) {
    if ((p1.test(na) && p2.test(nb)) || (p1.test(nb) && p2.test(na))) return true;
  }
  // O ≥ X.5 conflicts with U ≤ X.5 (e.g. O2.5 + U2.5, O3.5 + U2.5)
  const overMatch = /^O(\d\.\d)/.exec(na) || /^O(\d\.\d)/.exec(nb);
  const underMatch = /^U(\d\.\d)/.exec(na) || /^U(\d\.\d)/.exec(nb);
  if (overMatch && underMatch) {
    const oN = parseFloat(overMatch[1]);
    const uN = parseFloat(underMatch[1]);
    if (oN >= uN) return true;
  }
  return false;
}

export type RankedPick = {
  market: string;
  odd: number;
  family: string;
  win_rate: number | null;   // null = no historical data
  total: number;             // sample size
  missed: number;            // missed opportunities (won but not predicted)
  source: "pre+ai" | "pre" | "ai";  // concordance flag
  boost: number;             // score for ranking
  isCandidate: boolean;      // YELLOW prediction: 0 W/L + ≥5 missed, sample reliable
};

const MIN_RELIABLE_SAMPLE = 5;   // win-rate considered usable from this many results
const CANDIDATE_MIN_MISSED = 5;  // yellow flag threshold

/**
 * Build the FINAL ranked list combining pre-pronostic family + LLM markets,
 * with win-rate (when sample is reliable) and concordance BOOST.
 *
 * Rules applied:
 *  - quote < 1.40 → escluso (filtered at family level)
 *  - concordanza pre+AI = boost massimo (+0.30)
 *  - win_rate aggiunge fino a +1.00 (se ≥5 risultati storici)
 *  - quote più "sicure" (1.40-1.85) leggermente favorite
 *  - quote alte (>2.00) penalizzate (-0.15 per ogni unità sopra)
 *  - sample size bias: confidence = wr * (1 - 1/sqrt(total))  → poche valutazioni = meno peso
 */
export function rankPicks(
  preFamily: Candidate[],
  llmMarkets: string[],
  stats: { market: string; win_rate: number; total: number; missed?: number; family: string }[] = [],
): RankedPick[] {
  const norm = (m: string) => normalizeMarket(m);
  const statsByMarket = new Map<string, { rate: number; total: number; missed: number }>();
  const safeStats = Array.isArray(stats) ? stats : [];
  for (const s of safeStats) {
    statsByMarket.set(norm(s.market), { rate: s.win_rate, total: s.total, missed: s.missed || 0 });
  }
  const llmSet = new Set(llmMarkets.map(norm));

  // Build candidates from both sources (union)
  const map = new Map<string, RankedPick>();
  for (const c of preFamily) {
    const k = norm(c.market);
    const st = statsByMarket.get(k);
    const reliable = st && st.total >= MIN_RELIABLE_SAMPLE;
    map.set(k, {
      market: c.market,
      odd: c.odd,
      family: c.family,
      win_rate: reliable ? st!.rate : null,
      total: st?.total || 0,
      missed: st?.missed || 0,
      source: llmSet.has(k) ? "pre+ai" : "pre",
      boost: 0,
      isCandidate: !!st && st.total === 0 && st.missed >= CANDIDATE_MIN_MISSED,
    });
  }
  for (const lm of llmMarkets) {
    const k = norm(lm);
    if (map.has(k)) continue;
    const st = statsByMarket.get(k);
    const reliable = st && st.total >= MIN_RELIABLE_SAMPLE;
    map.set(k, {
      market: lm,
      odd: 0,
      family: "AI_ONLY",
      win_rate: reliable ? st!.rate : null,
      total: st?.total || 0,
      missed: st?.missed || 0,
      source: "ai",
      boost: 0,
      isCandidate: !!st && st.total === 0 && st.missed >= CANDIDATE_MIN_MISSED,
    });
  }

  // Calculate boost score
  const out: RankedPick[] = [];
  for (const p of map.values()) {
    let score = 0;
    if (p.source === "pre+ai") score += 0.30;
    if (p.win_rate !== null && p.total >= MIN_RELIABLE_SAMPLE) {
      // Sample-size weighted confidence
      const weight = 1 - 1 / Math.sqrt(p.total);
      score += (p.win_rate / 100) * weight;
    }
    // Quote band bonuses/penalties
    if (p.odd > 0) {
      if (p.odd >= 1.40 && p.odd <= 1.85) score += 0.15;      // sweet spot
      else if (p.odd > 1.85 && p.odd < 2.00) score += 0.05;
      else if (p.odd >= 2.00) score -= 0.15 * (p.odd - 1.85); // penalize high odds
    }
    p.boost = score;
    out.push(p);
  }
  // Ordina per boost desc, poi per quota asc (più sicura prima)
  out.sort((a, b) => b.boost - a.boost || (a.odd || 99) - (b.odd || 99));
  return out;
}

/**
 * Pick the FINAL bet from a ranked list, applying:
 *  - "no bet" if top of pre family and top of AI family are DISCORDANT
 *  - cascade: if top has odd < 1.40, descend to next
 */
export function pickFinal(ranked: RankedPick[], aiMarkets: string[] = []): {
  pick: RankedPick | null;
  isNoBet: boolean;
  reason?: string;
} {
  if (ranked.length === 0) return { pick: null, isNoBet: false };

  // Check discordance: top concordant pick vs any AI suggestion
  const topPre = ranked.find((r) => r.source !== "ai");
  const aiList = aiMarkets.length > 0 ? aiMarkets : ranked.filter((r) => r.source !== "pre").map((r) => r.market);
  if (topPre && aiList.length > 0) {
    // If TOP of pre is discordant with TOP of AI → NO BET
    const topAi = ranked.find((r) => r.source !== "pre");
    if (topAi && areDiscordant(topPre.market, topAi.market)) {
      return { pick: null, isNoBet: true, reason: `${topPre.market} vs ${topAi.market} discordanti` };
    }
  }

  // Cascade: skip picks with odd < 1.40 (already filtered) — apply as belt-and-braces
  for (const p of ranked) {
    if (p.odd === 0 || p.odd >= 1.40) return { pick: p, isNoBet: false };
  }
  return { pick: ranked[0], isNoBet: false };
}

// ============================================================
// VERDETTO FINALE — fonde i 3 sistemi (Strutturale, AI, Pre)
// ============================================================
export type VerdictSource = "structural" | "ai" | "pre";

export type VerdictPick = {
  market: string;
  score: number;
  sources: VerdictSource[];     // sistemi in cui appare
  ranks: Partial<Record<VerdictSource, number>>; // posizione nel rispettivo top-N
  odd?: number;                  // se reperibile da pre-pronostico o quote
  coverage?: number;             // dal motore strutturale
  fragility?: number;            // dal motore strutturale
  family?: string;
  concordance: number;           // numero di sistemi in cui appare (1-3)
  agreementLabel: "piena" | "forte" | "parziale" | "divergente";
  vetoed?: boolean;              // true se il motore strutturale ha posto veto
};

const SRC_WEIGHTS: Record<VerdictSource, { top: number; decay: number; bonus: number }> = {
  structural: { top: 10, decay: 1.6, bonus: 1.5 }, // motore matematico = priorità
  ai:         { top: 8,  decay: 1.4, bonus: 1.2 }, // AI semantica = supporto
  pre:        { top: 5,  decay: 0.7, bonus: 0.6 }, // euristica locale = filtro debole
};

const MIN_VALUE_ODD = 1.40; // sotto 1.40 il pick è solo rischio, niente valore

const MARKET_TO_ODD_KEY: Record<string, string> = {
  "1": "odd_1", "X": "odd_X", "2": "odd_2",
  "1X": "odd_1X", "X2": "odd_X2", "12": "odd_12",
  "U1.5": "odd_U15", "O1.5": "odd_O15",
  "U2.5": "odd_U25", "O2.5": "odd_O25",
  "U3.5": "odd_U35", "O3.5": "odd_O35",
  "GG": "odd_GG", "NG": "odd_NG",
};

/** Ritorna la quota canonica per un mercato dato (anche DC combo o "X + Y"). undefined se non derivabile. */
export function getMarketOdd(market: string, odds: any): number | undefined {
  if (!market || !odds) return undefined;
  const m = market.trim().toUpperCase().replace(/\s+/g, "");
  const direct = MARKET_TO_ODD_KEY[m];
  if (direct && typeof odds[direct] === "number" && odds[direct] > 0) return odds[direct];
  // Combo X + Y  (es. "DC 1X + U3.5", "2 + O1.5", "1 + O1.5")
  if (m.includes("+")) {
    const rest = market.replace(/^dc\s*/i, "").trim();
    const parts = rest.split("+").map((s) => s.trim()).filter(Boolean);
    if (parts.length === 2) {
      const o1 = getMarketOdd(parts[0], odds);
      const o2 = getMarketOdd(parts[1], odds);
      if (o1 && o2) return Math.round(o1 * o2 * 100) / 100;
    }
  }
  return undefined;
}

export function buildFinalVerdict(
  structural: StructuralAnalysis | null,
  preRanked: RankedPick[],
  aiMarkets: { market: string; reasoning?: string }[] | string[] | undefined,
  odds?: any,
  options?: { minOdd?: number },
): VerdictPick[] {
  const minOdd = options?.minOdd ?? MIN_VALUE_ODD;
  const norm = normalizeMarket;
  type Bucket = {
    market: string;            // canonical display name (first seen)
    score: number;
    sources: Set<VerdictSource>;
    ranks: Partial<Record<VerdictSource, number>>;
    odd?: number;
    coverage?: number;
    fragility?: number;
    family?: string;
  };
  const buckets = new Map<string, Bucket>();

  const ensure = (raw: string): Bucket => {
    const k = norm(raw);
    let b = buckets.get(k);
    if (!b) {
      b = { market: raw, score: 0, sources: new Set(), ranks: {} };
      buckets.set(k, b);
    }
    return b;
  };

  // === Source 1: Structural ranking (top 6) ===
  if (structural?.ranking) {
    structural.ranking.slice(0, 6).forEach((r, i) => {
      const b = ensure(r.market);
      const w = SRC_WEIGHTS.structural;
      b.score += Math.max(w.top - i * w.decay, 0);
      b.sources.add("structural");
      b.ranks.structural = i + 1;
      b.coverage = r.coverage;
      b.fragility = r.fragility;
    });
  }

  // === Source 2: AI playable markets (top 4) ===
  const aiList: string[] = Array.isArray(aiMarkets)
    ? (aiMarkets as any[]).map((x: any) => (typeof x === "string" ? x : x?.market)).filter(Boolean)
    : [];
  aiList.slice(0, 4).forEach((m, i) => {
    const b = ensure(m);
    const w = SRC_WEIGHTS.ai;
    b.score += Math.max(w.top - i * w.decay, 0);
    b.sources.add("ai");
    b.ranks.ai = i + 1;
  });

  // === Source 3: Pre-pronostico rankPicks (top 6) ===
  preRanked.slice(0, 6).forEach((p, i) => {
    const b = ensure(p.market);
    const w = SRC_WEIGHTS.pre;
    b.score += Math.max(w.top - i * w.decay, 0);
    b.sources.add("pre");
    b.ranks.pre = i + 1;
    if (p.odd > 0 && !b.odd) b.odd = p.odd;
    if (!b.family) b.family = p.family;
  });

  // === Compute canonical odds (per bucket) and concordance bonus ===
  // Build "whitelist" of markets approved by the structural engine (Poisson).
  // Any market proposed by AI/PRE but NOT in this list is structurally suspect.
  const structuralWhitelist = new Set<string>();
  if (structural?.ranking) {
    structural.ranking.forEach((r) => structuralWhitelist.add(norm(r.market)));
  }

  for (const b of buckets.values()) {
    if (odds && (b.odd === undefined || b.odd === null)) {
      const computed = getMarketOdd(b.market, odds);
      if (computed) b.odd = computed;
    }
    if (b.sources.size === 3) b.score += 4;        // piena
    else if (b.sources.size === 2) b.score += 1.5; // forte
  }

  // === Structural veto: penalize markets rejected by the Poisson engine ===
  // Only applied when we have a structural ranking to compare against.
  const vetoedKeys = new Set<string>();
  if (structural?.ranking && structural.ranking.length > 0) {
    for (const b of buckets.values()) {
      const key = norm(b.market);
      const inStructural = structuralWhitelist.has(key);
      // Skip veto if the market is in the structural top OR if it's only proposed by structural
      const onlyStructural = b.sources.size === 1 && b.sources.has("structural");
      if (!inStructural && !onlyStructural) {
        // Apply heavy penalty (-60% score) but don't fully remove (user can still see it)
        b.score *= 0.40;
        vetoedKeys.add(key);
      }
    }
  }

  // === STRUCTURAL PRIMACY ===
  // Il motore matematico (Poisson) è la guida. Se il suo PICK #1 è robusto
  // (coverage ≥ 60%, fragility ≤ 35%) gli diamo un boost massiccio così non
  // può essere battuto da una concordanza casuale AI+PRE su un pick inferiore.
  if (structural?.ranking && structural.ranking.length > 0) {
    const top = structural.ranking[0];
    const robust = top.coverage >= 0.60 && top.fragility <= 0.35;
    for (const b of buckets.values()) {
      const rank = b.ranks.structural;
      if (!rank) continue;
      if (rank === 1) {
        // PICK strutturale: boost forte se robusto, moderato altrimenti
        b.score += robust ? 10 : 5;
      } else if (rank === 2) {
        b.score += 3;
      } else if (rank === 3) {
        b.score += 1.5;
      }
    }

    // GUARDRAIL: se il PICK strutturale #1 è robusto, garantisci che il suo
    // score finale sia almeno il +15% sopra il massimo tra gli altri mercati.
    // Questo evita che concordanze casuali AI+PRE su mercati inferiori
    // (es. U2.5 quando il vero pick è MG 1-3 totali) battano il motore matematico.
    if (robust) {
      const topKey = norm(top.market);
      const topBucket = buckets.get(topKey);
      if (topBucket) {
        let maxOther = 0;
        for (const b of buckets.values()) {
          if (norm(b.market) !== topKey && b.score > maxOther) {
            maxOther = b.score;
          }
        }
        const minRequired = maxOther * 1.15 + 0.5;
        if (topBucket.score < minRequired) {
          topBucket.score = minRequired;
        }
      }
    }
  }

  // === COERENZA STRUTTURALE: Penalità Under quando pavimento ≥ 2 ===
  // Se il motore Poisson conferma un pavimento ≥ 2 (gol minimi attesi),
  // i mercati Under con soglia troppo bassa sono strutturalmente fragili.
  // Esempio: pavimento=2 + U3.5 → si vince solo per 2 o 3 gol totali,
  // ma con λ_max alto è facile vedere il 3°/4° gol.
  if (structural?.structure) {
    const floor = structural.structure.goal_floor;
    if (floor >= 2) {
      for (const b of buckets.values()) {
        const m = norm(b.market);
        // Match U(N).5 con N <= floor + 1 → soglia troppo vicina al pavimento
        const underMatch = m.match(/^U(\d+(?:\.\d+)?)/);
        if (underMatch) {
          const n = parseFloat(underMatch[1]);
          if (n - floor <= 1.5) {
            // Penalità: -25% allo score
            b.score *= 0.75;
          }
        }
        // Anche per combo "DC X + U(N).5"
        const comboUnder = m.match(/\+U(\d+(?:\.\d+)?)/);
        if (comboUnder) {
          const n = parseFloat(comboUnder[1]);
          if (n - floor <= 1.5) {
            b.score *= 0.85; // penalità più lieve sui combo
          }
        }
      }
    }
  }

  // === Build output ===
  const out: VerdictPick[] = Array.from(buckets.values())
    // Filter out picks below value threshold (sotto soglia = solo rischio, niente valore)
    .filter((b) => {
      // Se non riesco a determinare la quota → lascio passare (mercati MG non standard)
      if (b.odd === undefined || b.odd === null) return true;
      return b.odd >= minOdd;
    })
    .map((b) => {
      const c = b.sources.size;
      const agreementLabel: VerdictPick["agreementLabel"] =
        c === 3 ? "piena" : c === 2 ? "forte" : c === 1 ? "parziale" : "divergente";
      return {
        market: b.market,
        score: Math.round(b.score * 100) / 100,
        sources: Array.from(b.sources),
        ranks: b.ranks,
        odd: b.odd,
        coverage: b.coverage,
        fragility: b.fragility,
        family: b.family,
        concordance: c,
        agreementLabel,
        vetoed: vetoedKeys.has(norm(b.market)),
      };
    });
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ============================================================
// FILTRO ANTI-CONTRADDIZIONE per ALTERNATIVE CONCORDI
// ============================================================
// Date una giocata principale (PICK) e una lista di alternative, ritorna
// le alternative COERENTI fra loro e col PICK. Una alternativa viene
// scartata se:
//   1. Contraddice il PICK o un'alternativa già accettata
//   2. Viola i vincoli strutturali (floor/ceiling)
//
// Regole di contraddizione:
//   • Esiti opposti: 1↔X, 1↔2, 1↔X2, 2↔X, 2↔1X, 1X↔X2, 1X↔12, X2↔12, X↔12
//   • GG ↔ NG (e qualsiasi combo con GG vs combo con NG)
//   • Any Under ↔ Any Over (direzioni opposte)
//   • MG con range diversi sulla stessa categoria (TOTALI/CASA/OSPITE)
//   • DC + Over ↔ DC + Under (combo direzionali opposte)
//
// Vincoli strutturali:
//   • floor=0 → no MG che parte da 2+ (es. MG 2-4 totali)
//   • ceiling_open → no Under ≤ 3.5 puri o combo
// ============================================================

const _hasUnderRegex = /\bU\d(?:\.\d)?\b|\+\s*U\d(?:\.\d)?/i;
const _hasOverRegex = /\bO\d(?:\.\d)?\b|\+\s*O\d(?:\.\d)?/i;
const _hasGGRegex = /\bGG\b|\+\s*GG/i;
const _hasNGRegex = /\bNG\b|\+\s*NG/i;
const _mgRangeRegex = /MG\s+(\d+)\s*-\s*(\d+)(?:\s+(TOTALI|CASA|OSPITE))?/i;

function _hasUnder(m: string) { return _hasUnderRegex.test(m); }
function _hasOver(m: string) { return _hasOverRegex.test(m); }
function _hasGG(m: string) { return _hasGGRegex.test(m); }
function _hasNG(m: string) { return _hasNGRegex.test(m); }

const _OPPOSITES: Array<[string, string]> = [
  ["1", "X"], ["1", "2"], ["1", "X2"],
  ["2", "X"], ["2", "1X"],
  ["1X", "X2"], ["1X", "12"], ["X2", "12"], ["X", "12"],
  ["GG", "NG"],
  ["O1.5", "U1.5"], ["O2.5", "U2.5"], ["O3.5", "U3.5"],
];

/** Estrae il segno base (1/X/2/1X/X2/12) dal mercato, undefined se non trovato. */
function _extractSign(m: string): string | undefined {
  const norm = m.trim().toUpperCase().replace(/\s+/g, " ");
  // Mercato secco
  if (/^(1X|X2|12|1|X|2)$/.test(norm.split(" ")[0])) return norm.split(" ")[0];
  // Combo "X + Y" o "DC X + Y"
  const m2 = norm.match(/^(DC\s+)?(1X|X2|12|1|X|2)\s*\+/);
  if (m2) return m2[2];
  return undefined;
}

export function areMarketsContradictory(a: string, b: string): boolean {
  const A = a.trim().toUpperCase();
  const B = b.trim().toUpperCase();
  if (A === B) return false;

  // 1) Opposti diretti (puri)
  for (const [x, y] of _OPPOSITES) {
    if ((A === x && B === y) || (A === y && B === x)) return true;
  }

  // 2) Segni base incompatibili (anche dentro combo)
  const sA = _extractSign(A);
  const sB = _extractSign(B);
  if (sA && sB && sA !== sB) {
    for (const [x, y] of _OPPOSITES.slice(0, 9)) {
      if ((sA === x && sB === y) || (sA === y && sB === x)) return true;
    }
  }

  // 3) Direzioni Under vs Over (qualsiasi soglia → direzioni opposte)
  if (_hasUnder(A) && _hasOver(B)) return true;
  if (_hasOver(A) && _hasUnder(B)) return true;

  // 4) GG vs NG (incluse combo)
  if (_hasGG(A) && _hasNG(B)) return true;
  if (_hasNG(A) && _hasGG(B)) return true;

  // 5) MG con range diversi sulla stessa categoria
  const mA = A.match(_mgRangeRegex);
  const mB = B.match(_mgRangeRegex);
  if (mA && mB) {
    const catA = (mA[3] || "TOTALI").toUpperCase();
    const catB = (mB[3] || "TOTALI").toUpperCase();
    if (catA === catB) {
      const aLo = +mA[1], aHi = +mA[2];
      const bLo = +mB[1], bHi = +mB[2];
      if (aLo !== bLo || aHi !== bHi) return true;
    }
  }

  return false;
}

/** Verifica se un mercato VIOLA i vincoli strutturali (floor/ceiling).
 * Regole STRETTE (richiesta utente):
 *   • MG [lo-hi]: valido solo se `lo ≤ floor + 1` AND (open ? hi ≥ 6 : hi ≥ ceiling)
 *     - es. floor=0,ceiling=3: "MG 2-4" → lo=2 > 1 → INVALIDO
 *     - es. floor=2,ceiling=4: "MG 1-3" → hi=3 < 4 → INVALIDO
 *     - es. floor=2,open=true: "MG 2-4" → ceiling aperto ma hi=4 < 6 → INVALIDO
 *   • U(N.5): valido solo se ceiling chiuso e N == ceiling (es. U3.5 ok con ceiling=3)
 *     - se ceiling_open: tutti gli Under sono invalidi
 *   • O(N.5): valido solo se ceiling > N (es. O3.5 ok solo se tetto ≥ 4 o aperto)
 *     - se floor ≤ N AND ceiling ≤ N AND non-open → ridondante/incoerente
 *   • Combo (DC + U/O o 1/X/2 + U/O) seguono le stesse regole sulla parte U/O
 */
export function violatesStructure(market: string, floor: number, ceiling: number, ceilingOpen: boolean): boolean {
  const M = market.trim().toUpperCase();

  // ============ MG RANGE ============
  const mg = M.match(_mgRangeRegex);
  if (mg) {
    const mgLo = +mg[1];
    const mgHi = +mg[2];
    // Lower bound: MG deve includere il floor (lo ≤ floor+1)
    if (mgLo > floor + 1) return true;
    // Upper bound:
    if (ceilingOpen) {
      // ceiling aperto: serve un upper alto (≥ 6) o open
      if (mgHi <= 5) return true;
    } else {
      // ceiling chiuso: MG deve includere il ceiling (hi ≥ ceiling)
      if (mgHi < ceiling) return true;
    }
  }

  // ============ UNDER ============
  // U(N.5) - estrae N dal mercato (puro o combo)
  const underMatch = M.match(/U\s*(\d+)\.5/);
  if (underMatch) {
    const u = +underMatch[1];
    if (ceilingOpen) {
      // Ceiling aperto: TUTTI gli under sono incoerenti
      return true;
    }
    // U(N.5) valido se N >= ceiling - 1 (es. U3.5 ok con ceiling=3 o 4)
    // Più stretto: U deve essere ESATTAMENTE al ceiling chiuso
    if (u < ceiling - 1) return true; // troppo stretto rispetto al ceiling
    if (u > ceiling) return true; // U non taglia (es. U3.5 quando ceiling=2: già garantito, no value)
  }

  // ============ OVER ============
  const overMatch = M.match(/O\s*(\d+)\.5/);
  if (overMatch) {
    const o = +overMatch[1];
    // Over valido se floor potrebbe superare la soglia
    if (!ceilingOpen) {
      // Ceiling chiuso a C: O(N.5) richiede C > N (altrimenti impossibile)
      if (o >= ceiling) return true;
      // E richiede floor ≤ N (altrimenti già garantito, no value)
      if (floor > o) return true;
    }
    // Ceiling aperto: O sempre validi
  }

  return false;
}

/**
 * Filtra le alternative scartando quelle in contraddizione col PICK
 * o tra loro, o che violano i vincoli strutturali.
 * Ritorna max `limit` alternative coerenti.
 */
export function filterCoherentAlternatives(
  pick: VerdictPick,
  alternatives: VerdictPick[],
  structure?: { goal_floor: number; goal_ceiling: number; goal_ceiling_open?: boolean } | null,
  limit: number = 3,
): VerdictPick[] {
  const accepted: VerdictPick[] = [];
  const floor = structure?.goal_floor ?? 0;
  const ceiling = structure?.goal_ceiling ?? 7;
  const open = !!structure?.goal_ceiling_open;

  for (const alt of alternatives) {
    if (accepted.length >= limit) break;
    // Skip se viola vincoli strutturali (floor/ceiling)
    if (violatesStructure(alt.market, floor, ceiling, open)) continue;
    // Skip se contraddice il PICK principale
    if (areMarketsContradictory(pick.market, alt.market)) continue;
    // Skip se contraddice un'alternativa già accettata
    let conflicts = false;
    for (const acc of accepted) {
      if (areMarketsContradictory(acc.market, alt.market)) {
        conflicts = true;
        break;
      }
    }
    if (conflicts) continue;
    accepted.push(alt);
  }
  return accepted;
}


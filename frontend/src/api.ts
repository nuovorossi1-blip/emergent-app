/**
 * Chiamate alle Netlify Functions "proprie" (stesso dominio, niente Emergent).
 * Usata per gli endpoint gia' migrati su Supabase.
 */
async function netlifyReq<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${res.status} ${t}`);
  }
  return res.json();
}


export type MultiplaRequest = {
  day: string;
  events: number;
  minTotalOdd: number;
  minOdd?: number;
  minProb?: number;
  maxPerLeague?: number;
  /** Pattern di mercato ammessi: "1" "2" "O2.5" "GG" "1X" "X2".
   *  Vuoto o assente = nessun vincolo, il motore prende la giocata piu'
   *  probabile di ogni partita (comportamento fino al 19/09/2026). */
  patterns?: string[];
  locked?: { matchId: string; market: string }[];
  excludeMatches?: string[];
  excludeLeagues?: string[];
  apply?: boolean;
  replaceSelection?: boolean;
};

export type MultiplaLeg = {
  match_id: string;
  squadra1: string;
  squadra2: string;
  manifestazione: string;
  tier: 1 | 2 | 3;
  tier_label: string;
  time: string;
  market: string;
  prob: number;
  odd: number;
  odd_estimated: boolean;
  locked: boolean;
  alternatives: { market: string; prob: number; odd: number; odd_estimated: boolean }[];
  /** Quante volte quel mercato e' uscito davvero nel database: su partite con la
   *  stessa lettura di quote e su partite concluse dello stesso campionato.
   *  null quando il campione e' troppo piccolo (meno di 20 partite). */
  storico_scenario?: { pct: number; total: number } | null;
  storico_campionato?: { pct: number; total: number } | null;
};

export type MultiplaResponse = {
  ok: boolean;
  reason: string | null;
  error?: string;
  applied: boolean;
  day: string;
  requested: { events: number; minTotalOdd: number; minOdd: number; minProb: number; maxPerLeague: number };
  total_odd: number;
  total_estimated: boolean;
  total_prob: number;
  legs: MultiplaLeg[];
  tiers_used: number[];
  pool: { matches: number; candidates: number; skipped_started: number; skipped_excluded: number; skipped_no_play: number };
};

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
  /** verdetto finale della fusione, salvato su Supabase: card e dettaglio devono mostrarlo entrambi */
  pick_finale?: string | null;
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
  /** quota del mercato: reale se il bookmaker la fornisce, altrimenti stimata */
  odd?: number | null;
  /** true se `odd` è una stima del motore e non un prezzo del bookmaker */
  odd_estimated?: boolean;
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
  /** soglia di quota minima con cui è stato costruito questo ranking (Fase 2) */
  min_odd?: number;
  /** classifica dell'euristica PRE, calcolata lato server su tutto il catalogo */
  pre_ranking?: { market: string; odd: number }[];
  /** mercati su cui l'euristica PRE ha potuto esprimersi (hanno un prezzo reale) */
  pre_eligible?: string[];
  /** quota di OGNI mercato del catalogo, reale o stimata: serve a non lasciare mai un pick senza prezzo */
  market_odds?: Record<string, { odd: number; estimated: boolean }>;
  /** fino a che soglia di quota conviene spingersi SU QUESTA partita (null = nemmeno la piu' bassa) */
  soglia_consigliata?: number | null;
  /** cosa uscirebbe a ogni soglia: serve a spiegare il consiglio invece di imporlo */
  soglie_dettaglio?: { soglia: number; market: string; prob: number }[];
  structure: StructuralStructure;
  cluster: StructuralCluster[];
  central_cluster: StructuralCluster[];
  ranking: StructuralMarketRank[];
  pick: StructuralMarketRank | null;
  explanation: string;
};

export const api = {
  matches: (day?: string, q?: string) => {
    const p = new URLSearchParams();
    if (day) p.set("day", day);
    if (q) p.set("q", q);
    const qs = p.toString();
    return netlifyReq<Match[]>(`/matches-list${qs ? `?${qs}` : ""}`);
  },
  days: () => netlifyReq<string[]>("/matches-days"),
  match: (id: string) => netlifyReq<Match & { prediction?: Prediction }>(`/match-detail?id=${encodeURIComponent(id)}`),
  predict: (id: string, force?: boolean) =>
    netlifyReq<Prediction>(`/ai-predict?matchId=${encodeURIComponent(id)}${force ? "&force=true" : ""}`, { method: "POST" }),
  setResult: (id: string, result: string) =>
    netlifyReq<{ ok: boolean; learning?: { applied: boolean; main_prediction?: string; result_ok?: boolean } }>(`/match-result`, {
      method: "POST",
      body: JSON.stringify({ matchId: id, result }),
    }),
  bulkResults: (items: { id: string; result: string }[]) =>
    netlifyReq<{ updated: number; learnings?: any[] }>(`/results-bulk`, {
      method: "POST",
      body: JSON.stringify({ items }),
    }),
  // FASE 0 — registra il verdetto finale della fusione, che prima viveva solo
  // nel browser. Serve sia a ritrovare il pick riaprendo la partita, sia a
  // misurare la precisione della fusione a risultato inserito.
  saveVerdict: (matchId: string, market: string, prob?: number) =>
    netlifyReq<{ ok: boolean }>(`/save-verdict`, {
      method: "POST",
      body: JSON.stringify({ matchId, market, prob }),
    }),
  // 18/09/2026 — multipla automatica (vedi netlify/functions/build-multipla.ts).
  // Il motore sceglie N partite del giorno con la giocata piu' probabile
  // ciascuna, fino alla quota totale minima, campionati a scalare (1 -> 2 -> 3).
  buildMultipla: (body: MultiplaRequest) =>
    netlifyReq<MultiplaResponse>(`/build-multipla`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  statsScores: () => netlifyReq<Record<string, any[]>>("/stats-scores"),
  statsReset: () => netlifyReq<{ ok: boolean }>("/stats-reset", { method: "POST" }),
  updateSelection: (ids: string[], selected: boolean) =>
    netlifyReq<{ ok: boolean }>(`/selection-update`, {
      method: "POST",
      body: JSON.stringify({ ids, selected }),
    }),
  selectedList: () => netlifyReq<Match[]>("/selected-list"),
  clearSelection: () => netlifyReq<{ ok: boolean }>(`/selection-clear`, { method: "POST" }),
  exportDb: () => netlifyReq<any>("/export-db"),
  importDb: (payload: any) =>
    netlifyReq<any>(`/import-db`, { method: "POST", body: JSON.stringify(payload) }),
  deleteAll: () => netlifyReq<{ ok: boolean }>(`/delete-all`, { method: "DELETE" }),
  aiStudioPrompt: () => netlifyReq<{ csv: string; count: number }>(`/aistudio-prompt`),
  getLlmSettings: () => netlifyReq<{ options: any[]; selected_id: string }>("/llm-settings"),
  setLlmSettings: (id: string) => netlifyReq<{ ok: boolean; selected_id: string }>("/llm-settings", { method: "POST", body: JSON.stringify({ id }) }),
  getBudget: () => netlifyReq<{ estimated_spent_usd: number; predictions_made: number; current_model: string; cost_per_prediction_usd: number; topup_url: string }>("/budget"),
  resetBudget: () => netlifyReq<{ ok: boolean }>("/budget?reset=true", { method: "POST" }),
  marketStats: () => netlifyReq<{ markets: { family: string; market: string; wins: number; losses: number; total: number; missed: number; family_total: number; miss_rate: number; win_rate: number }[]; family_totals: Record<string, number> }>("/ml-stats"),
  fetchResultsAuto: (ids: string[], apply = true, apply_threshold = 80) => netlifyReq<{ results: any[]; applied: number; not_found: number; skipped: number }>("/results-fetch", { method: "POST", body: JSON.stringify({ ids, apply, apply_threshold }) }),
  applyResultManual: (id: string, score: string) => netlifyReq<{ ok: boolean; result: string }>("/results-apply", { method: "POST", body: JSON.stringify({ id, score }) }),
  matchCandidates: (id: string) => netlifyReq<{ candidates: { market: string; family: string; missed: number; family_total: number; miss_rate: number }[]; family: string | null; family_total: number }>(`/match-candidates?id=${encodeURIComponent(id)}`),
  matchHistory: (id: string) => netlifyReq<MatchHistory>(`/match-history?id=${encodeURIComponent(id)}`),
  matchStructural: (id: string, minOdd?: number) =>
    netlifyReq<StructuralAnalysis>(
      `/predict?matchId=${encodeURIComponent(id)}${minOdd ? `&minOdd=${minOdd}` : ""}`,
    ),
  // FASE 2 — soglia di quota minima scelta dall'utente
  getMinOdd: () => netlifyReq<{ min_odd: number; options: number[] }>("/odd-settings"),
  setMinOdd: (minOdd: number) =>
    netlifyReq<{ ok: boolean; min_odd: number }>("/odd-settings", {
      method: "POST",
      body: JSON.stringify({ min_odd: minOdd }),
    }),
  uploadExcel: async (uri: string, name: string, mimeType?: string) => {
    const form = new FormData();
    if (typeof window !== "undefined" && uri.startsWith("blob:")) {
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
    const res = await fetch(`/upload-excel`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json() as Promise<{ inserted: number; updated: number; unchanged?: number; skipped: number; total_parsed: number; rows_seen?: number }>;
  },
  uploadSkipped: () => netlifyReq<UploadSkippedReport>(`/upload-skipped`),
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
  const o1 = get("odd_1"), o2 = get("odd_2");
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
    // NIENTE bonus per la concordanza con l'IA (era `+= 0.30` quando
    // source === "pre+ai"). Motivo: la fusione conta il pre-pronostico come
    // TERZO parere indipendente, ma con quel bonus la sua classifica veniva
    // riordinata dai mercati proposti dall'IA — cioe' in parte ne era un'eco.
    // Risultato: "CONCORDANZA 2/3 = AI + PRE" contava spesso due volte lo
    // stesso parere. Si vedeva a occhio nudo: su Vasco Da Gama - Mirassol il
    // pick PRE era X2 prima del click sul Pronostico AI e diventava GG dopo,
    // pur non essendo cambiata nessuna quota.
    // L'etichetta "pre+ai" resta, come informazione a schermo: e' solo
    // l'ORDINAMENTO che non deve piu' dipenderne. Il pre-pronostico ora si
    // regge unicamente sulle quote reali del bookmaker e sullo storico —
    // l'unica cosa che sa davvero, e l'unica che il motore Poisson non guarda.
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
/**
 * Mercati ammessi nel VERDETTO FINALE, decisi da Rossi.
 * Il ranking strutturale continua a mostrarli tutti — serve a capire cosa pensa
 * il motore — ma la giocata consigliata esce solo da qui, perche' e' quello che
 * lui gioca davvero. Fuori per scelta esplicita: tutte le combo con DC 12, i
 * multigol, il segno secco, U1.5 / U2.5 / O3.5.
 * Deve restare allineata a VERDICT_WHITELIST in netlify/functions/lib/clusterEngine.ts.
 */
const VERDICT_WHITELIST = new Set([
  "1", "2",
  "1x", "x2",
  // NG tolto il 18/09/2026 su decisione di Rossi: non lo gioca. Resta nel
  // ranking strutturale, ma non puo' piu' diventare la giocata.
  "gg",
  "o2.5",
  "mg 2-4 totali", "mg 3-6 totali",
  "gg + o2.5",
  "dc 1x + o1.5", "dc x2 + o1.5",
  "dc 1x + o2.5", "dc x2 + o2.5",
  "dc 1x + u3.5", "dc x2 + u3.5",
  "dc 1x + gg", "dc x2 + gg",
]);

/**
 * Mercati che raccontano la partita in modo OPPOSTO. Non devono mai
 * sostituirsi a vicenda solo perche' uno e' sotto soglia: sarebbe ribaltare la
 * lettura della partita per una ragione di prezzo.
 * Deve restare allineata a OPPOSTI in netlify/functions/lib/clusterEngine.ts.
 */
const OPPOSTI: [string, string][] = [
  ["1", "2"], ["1", "x2"], ["2", "1x"], ["1x", "x2"],
  ["gg", "ng"],
  ["o2.5", "u2.5"], ["o1.5", "u1.5"], ["o2.5", "ng"],
];

function pezzi(market: string): string[] {
  return market.split("+").map((p) => p.trim().replace(/^dc /i, "").toLowerCase());
}

/** true se `candidato` contraddice la lettura espressa da `direzione`. */
function contraddice(direzione: string, candidato: string): boolean {
  const a = pezzi(direzione), b = pezzi(candidato);
  return a.some((x) => b.some((y) =>
    OPPOSTI.some(([p, q]) => (p === x && q === y) || (q === x && p === y))));
}

/** A quale famiglia appartiene un mercato: esito, gol, oppure totali. */
function famiglia(market: string): "esito" | "gol" | "totali" | null {
  const p = pezzi(market).map((x) => x.toUpperCase());
  if (p.some((x) => ["1", "2", "1X", "X2"].includes(x))) return "esito";
  if (p.some((x) => ["GG", "NG"].includes(x))) return "gol";
  if (p.some((x) => x.startsWith("O") || x.startsWith("U") || x.startsWith("MG"))) return "totali";
  return null;
}

/**
 * Famiglie su cui il motore non ha una lettura: i due mercati OPPOSTI piu' alti
 * sono separati da pochi punti. Su Zaglebie - Piast il ranking dava `X2` 65% e
 * `1X` 62%: tre punti fra due scenari opposti non sono una lettura, sono un
 * pareggio. Si salta la famiglia e si scende dove il motore ha qualcosa da dire.
 * Deve restare allineata a famiglieAmbigue in clusterEngine.ts.
 */
function famiglieAmbigue(lista: VerdictPick[], prob: (b: VerdictPick) => number): Set<string> {
  const out = new Set<string>();
  for (const fam of ["esito", "gol", "totali"]) {
    const della = lista.filter((r) => famiglia(r.market) === fam);
    if (della.length < 2) continue;
    const primo = della[0];
    const opposto = della.find((r) => contraddice(primo.market, r.market));
    if (opposto && Math.abs(prob(primo) - prob(opposto)) <= 0.05) out.add(fam);
  }
  return out;
}

/**
 * Mercati tolti dalla whitelist che restano una LETTURA della partita: non si
 * giocano, ma vietano i mercati opposti piu' in basso e rendono ambigua la loro
 * famiglia quando sono appaiati al proprio contrario.
 * Deve restare allineata a VETO_ONLY_MARKETS in clusterEngine.ts.
 */
const VETO_ONLY = new Set(["ng"]);

function isVetoOnly(market: string): boolean {
  return VETO_ONLY.has(market.trim().toLowerCase().replace(/\s{2,}/g, " "));
}

export function isVerdictMarket(market: string): boolean {
  return VERDICT_WHITELIST.has(market.trim().toLowerCase().replace(/\s{2,}/g, " "));
}

export type VerdictSource = "structural" | "ai" | "pre";

export type VerdictPick = {
  market: string;
  score: number;
  sources: VerdictSource[];     // sistemi in cui appare
  ranks: Partial<Record<VerdictSource, number>>; // posizione nel rispettivo top-N
  odd?: number;                  // se reperibile da pre-pronostico o quote
  oddEstimated?: boolean;        // true se la quota è stimata dal motore (mercati senza prezzo, es. multigol)
  coverage?: number;             // dal motore strutturale
  fragility?: number;            // dal motore strutturale
  family?: string;
  concordance: number;           // numero di sistemi in cui appare (1-3)
  agreementLabel: "piena" | "forte" | "parziale" | "divergente";
  vetoed?: boolean;              // true se il motore strutturale ha posto veto
  ambiguousPair?: boolean;       // true se questo pick forma una coppia opposta ravvicinata col #1/#2 (es. GG vs NG testa a testa)
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

export type MatchHistoryStat = { market: string; wins: number; total: number; win_rate: number; missed: number };
export type TeamForm = { matches: number; avg_scored: number; avg_conceded: number } | null;
export type MatchHistory = {
  league: string | null;
  global: Record<string, MatchHistoryStat[]>;
  league_specific: Record<string, MatchHistoryStat[]>;
  team_form?: { home: TeamForm; away: TeamForm };
};

// Numero minimo di partite perché il dato per-campionato sia considerato
// affidabile abbastanza da rifinire quello globale (che invece è sempre
// ben popolato per famiglia, quindi usato come base di default).
const MIN_LEAGUE_SAMPLE = 30;

function getHistoricalRate(
  history: MatchHistory | null | undefined,
  family: string | undefined,
  market: string,
): { rate: number; total: number } | undefined {
  if (!history || !family) return undefined;
  const key = normalizeMarket(market);
  const leagueStats = history.league_specific?.[family];
  const leagueStat = leagueStats?.find((s) => normalizeMarket(s.market) === key);
  if (leagueStat && leagueStat.total >= MIN_LEAGUE_SAMPLE) {
    return { rate: leagueStat.win_rate / 100, total: leagueStat.total };
  }
  const globalStats = history.global?.[family];
  const globalStat = globalStats?.find((s) => normalizeMarket(s.market) === key);
  if (globalStat && globalStat.total > 0) {
    return { rate: globalStat.win_rate / 100, total: globalStat.total };
  }
  return undefined;
}

export function buildFinalVerdict(
  structural: StructuralAnalysis | null,
  preRanked: RankedPick[],
  aiMarkets: { market: string; reasoning?: string }[] | string[] | undefined,
  odds?: any,
  history?: MatchHistory | null,
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
    oddEstimated?: boolean;
    /** quanti sistemi potevano esprimersi su questo mercato (2 o 3) */
    eligibleSystems?: number;
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
  // `preRanked` contiene anche i mercati proposti SOLO dall'IA (rankPicks li
  // unisce alla lista). Contarli come voto del pre-pronostico significa contare
  // due volte lo stesso parere: e' cosi' che "MG 1-4 totali" e' arrivato a
  // "AI #1 + PRE #1 = concordanza 2/3" pur essendo stato proposto da un sistema
  // solo. Qui li saltiamo: il voto "pre" lo danno solo i mercati che il
  // pre-pronostico ha davvero in classifica per conto suo.
  preRanked.filter((p) => p.source !== "ai").slice(0, 6).forEach((p, i) => {
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

  // TUTTI i mercati ammessi al verdetto entrano fra i candidati, anche quelli
  // che nessuno dei tre sistemi ha nominato nei suoi primi posti. Prima i
  // candidati erano solo i top-N di ciascun sistema, quindi un mercato come
  // `DC 1X + O2.5` — dodicesimo nel ranking strutturale — non veniva mai
  // considerato: su Colo Colo - Limache a soglia 1,60 la fusione ripiegava su
  // `NG` @2,20 al 48% mentre il motore aveva gia' individuato `DC 1X + O2.5`
  // al 54%, coerente con la lettura della partita.
  if (structural?.ranking) {
    for (const r of structural.ranking) {
      if (!isVerdictMarket(r.market)) continue;
      const k = norm(r.market);
      if (buckets.has(k)) continue;
      // La quota si risolve SUBITO, con tutte le strade disponibili: dalla voce
      // del ranking, dalla mappa completa market_odds, o dalle quote grezze.
      // Se restasse indefinita il mercato verrebbe scartato dal filtro di
      // soglia e il verdetto scivolerebbe piu' in basso — e' cosi' che su
      // Zaglebie - Piast usciva `O2.5` al 45% invece di `MG 2-4 totali` al 60%.
      const daMappa = structural?.market_odds?.[norm(r.market)] || structural?.market_odds?.[r.market];
      const quota = r.odd ?? daMappa?.odd ?? (odds ? getMarketOdd(r.market, odds) : undefined);
      buckets.set(k, {
        market: r.market, score: 0, sources: new Set(), ranks: {},
        coverage: r.coverage, fragility: r.fragility,
        odd: quota ?? undefined,
        oddEstimated: r.odd_estimated ?? daMappa?.estimated ?? false,
      } as any);
    }
  }

  // Mercati su cui l'euristica PRE ha potuto esprimersi. Se il backend non
  // manda la lista (versione vecchia), si assume che potesse su tutto: il
  // comportamento torna quello di prima, senza sorprese.
  const preEligible: Set<string> | null = structural?.pre_eligible
    ? new Set(structural.pre_eligible.map((m) => norm(m)))
    : null;

  for (const b of buckets.values()) {
    if (odds && (b.odd === undefined || b.odd === null)) {
      const computed = getMarketOdd(b.market, odds);
      if (computed) b.odd = computed;
    }
    // Se il bookmaker non dà un prezzo (tutti i multigol, diverse combo), usiamo
    // la quota stimata dal motore strutturale. Prima questi mercati restavano
    // senza quota e sfuggivano a ogni filtro: erano la maggioranza dei pick.
    if (b.odd === undefined || b.odd === null) {
      // Prima si cercava solo dentro `ranking`, che e' il TOP 20: i mercati
      // scartati dal motore restavano senza prezzo e sfuggivano al filtro.
      // `market_odds` copre invece l'intero catalogo.
      const fromMap = structural?.market_odds?.[norm(b.market)]
        || structural?.market_odds?.[b.market];
      if (fromMap?.odd) {
        b.odd = fromMap.odd;
        b.oddEstimated = !!fromMap.estimated;
      } else {
        const fromEngine = structural?.ranking?.find((r) => norm(r.market) === norm(b.market));
        if (fromEngine?.odd) {
          b.odd = fromEngine.odd;
          b.oddEstimated = !!fromEngine.odd_estimated;
        }
      }
    }
    // La concordanza fra sistemi INDIPENDENTI è il segnale più forte che
    // abbiamo (metodi diversi che arrivano alla stessa conclusione).
    //
    // CORREZIONE: prima si contavano i sistemi che avevano scelto quel
    // mercato, senza chiedersi se gli altri POTEVANO sceglierlo. L'euristica
    // PRE ragiona sulle quote reali del bookmaker, e per i 16 multigol
    // semplici un prezzo non esiste: quei mercati risultavano "poco condivisi"
    // non perché l'euristica li bocciasse, ma perché non aveva modo di
    // esprimersi. Era una penalità sistematica contro i multigol.
    //
    // Ora la concordanza si misura solo fra i sistemi che potevano votare.
    // Unanimità fra tre vale più di unanimità fra due: nel secondo caso i
    // pareri indipendenti sono comunque meno.
    const eligible = eligibleSystemsFor(b.market, preEligible);
    const agree = b.sources.size;
    if (agree >= 2 && agree >= eligible) b.score += eligible >= 3 ? 8 : 4;
    else if (agree === 2) b.score += 2.5;
    b.eligibleSystems = eligible;
  }

  // === Segnale strutturale debole: lieve penalità (non veto) per i mercati
  // che il motore Poisson non ha messo nella sua top-6. Non è più un "rifiuto"
  // (-60%), solo un fattore in meno nel punteggio: i 3 sistemi competono ad
  // armi pari, non c'è più un vincitore garantito a priori.
  const vetoedKeys = new Set<string>();
  if (structural?.ranking && structural.ranking.length > 0) {
    for (const b of buckets.values()) {
      const key = norm(b.market);
      const inStructural = structuralWhitelist.has(key);
      const onlyStructural = b.sources.size === 1 && b.sources.has("structural");
      if (!inStructural && !onlyStructural) {
        b.score *= 0.85; // lieve penalità, non più eliminazione di fatto
        vetoedKeys.add(key);
      }
    }
  }

  // === Contributo strutturale ===
  // Il motore Poisson resta un input autorevole (è l'unico con base matematica
  // sui gol attesi), quindi il suo pick #1 riceve un bonus additivo — ma da
  // solo non deve poter superare una concordanza piena a 3 sistemi indipendenti
  // (vedi bonus concordanza sopra, ora più alto di questo).
  if (structural?.ranking && structural.ranking.length > 0) {
    const top = structural.ranking[0];
    const robust = top.coverage >= 0.60 && top.fragility <= 0.35;
    for (const b of buckets.values()) {
      const rank = b.ranks.structural;
      if (!rank) continue;
      if (rank === 1) {
        b.score += robust ? 3 : 1.5;
      } else if (rank === 2) {
        b.score += 1;
      } else if (rank === 3) {
        b.score += 0.5;
      }
    }
  }

  // === CORRETTIVO COVERAGE REALE: verifica di realtà per ogni mercato ===
  // Caso Colorado Springs-Miami FC: AI e PRE concordavano su O2.5 (coverage
  // reale 47%, sotto la metà) contro NG proposto solo dal motore Poisson
  // (coverage 64%). O2.5 vinceva comunque, perché il blocco sopra guarda solo
  // la top-6 del motore strutturale — O2.5 era 7°, quindi la sua coverage non
  // veniva mai controllata da nessuno. Qui recuperiamo la coverage reale per
  // OGNI mercato che il motore ha calcolato (fino al 20° posto, non solo i
  // primi 6) e la usiamo come correttivo indipendente da chi propone il
  // mercato o da quanti sistemi sono d'accordo: sopra il 50% = bonus,
  // sotto il 50% = penalità, proporzionale alla distanza.
  if (structural?.ranking) {
    for (const r of structural.ranking) {
      const b = buckets.get(norm(r.market));
      if (b && b.coverage === undefined) {
        b.coverage = r.coverage;
        b.fragility = r.fragility;
      }
    }
  }
  const COVERAGE_WEIGHT = 30;
  for (const b of buckets.values()) {
    if (b.coverage !== undefined) {
      b.score += (b.coverage - 0.5) * COVERAGE_WEIGHT;
    }
  }

  // === CORRETTIVO STORICO REALE: divario tra coverage dichiarata e win-rate
  // vero della famiglia ===
  // Caso reale San Jose-Orlando: "1" aveva coverage 78% (motore Poisson),
  // ma lo storico reale di DOMINANZA_OVER dice che "1" vince solo il 48%
  // delle volte — un divario enorme che nessuno controllava. Qui, quando
  // sia la coverage che lo storico sono disponibili per lo stesso mercato,
  // penalizziamo il divario in eccesso oltre una soglia di tolleranza
  // (15 punti — differenze piccole sono normali rumore statistico, non un
  // allarme). Se la coverage promette molto più di quanto lo storico
  // conferma, il pick viene ridimensionato proporzionalmente all'eccesso.
  // Se non c'è coverage (mercato proposto solo da AI/PRE) usiamo lo storico
  // da solo, con un peso più leggero perché è l'unico segnale disponibile.
  const matchFamily = structural?.structure?.family;
  const HIST_GAP_WEIGHT = 45;   // penalità per punto di divario in eccesso
  const HIST_GAP_TOLERANCE = 0.15;
  const HIST_ONLY_WEIGHT = 15;  // più leggero: unico segnale disponibile
  for (const b of buckets.values()) {
    const hist = getHistoricalRate(history, matchFamily, b.market);
    if (!hist) continue;
    if (b.coverage !== undefined) {
      const gap = b.coverage - hist.rate;
      if (gap > HIST_GAP_TOLERANCE) {
        b.score -= (gap - HIST_GAP_TOLERANCE) * HIST_GAP_WEIGHT;
      }
    } else {
      b.score += (hist.rate - 0.5) * HIST_ONLY_WEIGHT;
    }
  }

  // === Combo ridondanti: penalità se il segno singolo ha già valore da solo ===
  // Una combo "1X + O2.5" ha senso SOLO se il segno secco (1X) è sotto soglia
  // di valore (quota troppo bassa). Se il segno singolo ha già una quota
  // giocabile (≥ minOdd), la combo è ridondante e va proposta come pick
  // principale solo la versione singola.
  for (const b of buckets.values()) {
    if (b.market.includes("+")) {
      const baseSign = b.market.split("+")[0].replace(/^dc\s*/i, "").trim();
      const baseOdd = getMarketOdd(baseSign, odds);
      if (baseOdd !== undefined && baseOdd >= minOdd) {
        b.score *= 0.5;
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
    // Solo i mercati che Rossi gioca davvero (vedi VERDICT_WHITELIST).
    .filter((b) => isVerdictMarket(b.market))
    .filter((b) => {
      // Nessun pick senza prezzo. Prima i mercati di cui non si riusciva a
      // determinare la quota passavano il filtro: e' cosi' che "MG 1-4 totali"
      // (quota stimata 1,17, sotto qualsiasi soglia) e' finito come giocata
      // consigliata senza nemmeno una quota accanto. Un pick che non si sa
      // quanto paga non e' giocabile, quindi non deve arrivare a schermo.
      // La soglia NON si applica qui: se togliessimo subito i mercati sotto
      // soglia perderemmo la "direzione" della partita, che e' il mercato piu'
      // probabile a prescindere dal prezzo. La soglia entra dopo, nella
      // selezione finale.
      return b.odd !== undefined && b.odd !== null && b.odd > 0;
    })
    .map((b) => {
      const c = b.sources.size;
      const eligible = b.eligibleSystems ?? 3;
      const agreementLabel: VerdictPick["agreementLabel"] =
        c >= 2 && c >= eligible ? "piena" : c === 2 ? "forte" : c === 1 ? "parziale" : "divergente";
      return {
        market: b.market,
        score: Math.round(b.score * 100) / 100,
        sources: Array.from(b.sources),
        ranks: b.ranks,
        odd: b.odd,
        oddEstimated: b.oddEstimated,
        coverage: b.coverage,
        fragility: b.fragility,
        family: b.family,
        concordance: c,
        agreementLabel,
        vetoed: vetoedKeys.has(norm(b.market)),
      };
    });
  // ORDINAMENTO FINALE — coerente con il criterio del motore (ordina per
  // probabilita' vera, non per punteggio).
  //
  // Il punteggio della fusione da' bonus in base alla POSIZIONE che un mercato
  // occupa nelle tre classifiche. Ma alzando la soglia di quota si rimuovono i
  // mercati piu' economici e tutti gli altri salgono di posizione, quindi il
  // punteggio cambia anche se la loro probabilita' e' rimasta identica. Da qui
  // l'oscillazione vista su Nacional Potosi - Real Tomayapo: NG a soglia 1,40,
  // GG a 1,50, di nuovo NG a 1,60, senza che nulla fosse cambiato nei mercati.
  // E soprattutto: a 1,40 la fusione sceglieva NG al 50% scavalcando un mercato
  // al 64%, cioe' il contrario dell'obiettivo "massima probabilita' sopra la
  // soglia".
  //
  // Regola: comanda la probabilita'. Il punteggio della fusione (concordanza
  // fra i sistemi compresa) decide solo fra mercati vicini, entro 5 punti di
  // probabilita': li' e' un vero spareggio, non un ribaltamento.
  // ORDINE = quello del ranking strutturale, punto.
  // La regola concordata e' "si scorre il ranking dall'alto e si prende il primo
  // ammesso che paga abbastanza": se qui riordinassimo con criteri nostri,
  // scorreremmo una lista diversa da quella che l'utente vede a schermo.
  // Succedeva su Atletico Ottawa - Pacific: `1` era quarto nel ranking con 63% e
  // quota 1,57, `O2.5` settimo con 59% e 1,52; il vecchio spareggio "entro 5
  // punti vince la quota piu' bassa" faceva vincere O2.5, cioe' il secondo.
  // Lo spareggio sulla quota resta, ma solo a probabilita' DAVVERO pari (entro
  // un punto), che e' il caso GG/NG per cui era nato.
  const posizione = new Map<string, number>();
  structural?.ranking?.forEach((r, i) => posizione.set(norm(r.market), i));
  out.sort((a, b) => {
    const ia = posizione.get(norm(a.market)), ib = posizione.get(norm(b.market));
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return b.score - a.score;
  });


  // === Mercati opposti ravvicinati (es. NG vs GG testa a testa) ===
  // Se il #1 e il #2 sono mercati mutuamente esclusivi con punteggio vicino
  // (entro il 20%), nessuno dei due è un pick affidabile da solo: si passa
  // al primo mercato successivo che non è in conflitto con nessuno dei due.
  // I due mercati ambigui restano visibili in lista, solo marcati.
  if (out.length >= 3) {
    const [first, second] = out;
    if (areMarketsContradictory(first.market, second.market)) {
      const gap = first.score > 0 ? (first.score - second.score) / first.score : 0;
      if (gap < 0.20) {
        const fallbackIdx = out.findIndex((v, i) =>
          i >= 2 &&
          !areMarketsContradictory(v.market, first.market) &&
          !areMarketsContradictory(v.market, second.market),
        );
        if (fallbackIdx !== -1) {
          first.ambiguousPair = true;
          second.ambiguousPair = true;
          const [fallback] = out.splice(fallbackIdx, 1);
          out.unshift(fallback);
        }
      }
    }
  }

  // ============================================================
  // SELEZIONE FINALE — regole decise con Rossi il 27/07/2026
  // ============================================================
  // 1. La direzione della partita e' il mercato ammesso piu' probabile, quota o
  //    non quota: e' la lettura del motore e non si tocca.
  // 2. Se paga abbastanza, e' lui.
  // 3. Altrimenti si prova a RAFFORZARLO con una combo coerente: aggiungere una
  //    condizione alza la quota senza cambiare lettura.
  // 4. Altrimenti si scende, saltando tutto cio' che contraddice la direzione.
  // 5. Se non resta niente si dichiara valore nullo: meglio nessuna giocata che
  //    una giocata contro la propria analisi.
  if (!out.length) return out;
  const probOf = (b: VerdictPick) =>
    b.coverage ?? structural?.ranking?.find((r) => norm(r.market) === norm(b.market))?.coverage ?? 0;
  // I mercati "solo veto" (NG) non sono piu' candidati, ma restano la lettura
  // della partita: entrano nel calcolo delle famiglie ambigue e vietano i
  // mercati opposti che stanno sotto di loro nel ranking. Senza questo, in una
  // partita difensiva il verdetto poteva scivolare su GG appena le alternative
  // finivano sotto soglia.
  const vetoPicks: VerdictPick[] = (structural?.ranking || [])
    .filter((r) => isVetoOnly(r.market))
    .map((r) => ({
      market: r.market, score: 0, sources: [], ranks: {},
      odd: r.odd ?? undefined, coverage: r.coverage,
      concordance: 0, agreementLabel: "divergente",
    }));
  const lettura = [...out, ...vetoPicks].sort((a, b) => probOf(b) - probOf(a));

  const ambigue = famiglieAmbigue(lettura, probOf);
  const leggibili = out.filter((b) => {
    const f = famiglia(b.market);
    return !f || !ambigue.has(f);
  });
  if (!leggibili.length) return [];      // nessuna famiglia leggibile: si sta fuori

  const sopra = (b: VerdictPick) => (b.odd ?? 0) >= minOdd;
  // Un mercato e' valido solo se non contraddice NESSUNO di quelli piu' in alto,
  // non solo la direzione: se un mercato piu' probabile dice il contrario,
  // quello sotto non si gioca. Senza questo, alzando la soglia il pick poteva
  // passare da `NG` a `GG` perche' entrambi erano compatibili con la direzione.
  const vietatoDaVeto = (b: VerdictPick) =>
    vetoPicks.some((v) => probOf(v) > probOf(b) && contraddice(v.market, b.market));
  const coerenti = leggibili.filter(
    (b, i) =>
      !leggibili.slice(0, i).some((sopra) => contraddice(sopra.market, b.market)) &&
      !vietatoDaVeto(b),
  );
  const scelto = coerenti.find(sopra);
  if (!scelto) return [];                    // valore nullo: nessuna giocata
  return [scelto, ...coerenti.filter((b) => sopra(b) && b.market !== scelto.market)];

}

// ============================================================
// WARNING AMICHEVOLE + QUOTA ESTREMA
// ============================================================
// In amichevole le squadre spesso schierano riserve: una quota estrema
// (favorita nettissima) è meno affidabile che nello stesso scenario in
// campionato. Non cambia il pick calcolato, ma avvisa l'utente di
// abbassare la fiducia — è il caso Napoli-Arezzo (quota 1 a 1.16, finita
// 1-3 per l'Arezzo).
// ============================================================
const EXTREME_ODD_THRESHOLD = 1.25;

export function getMatchCautionWarning(
  manifestazione: string | null | undefined,
  odds: Odds | null | undefined,
): string | null {
  if (!manifestazione || !odds) return null;
  const isFriendly = /^AMI\b/i.test(manifestazione.trim());
  if (!isFriendly) return null;
  const o1 = odds.odd_1 ?? 99;
  const o2 = odds.odd_2 ?? 99;
  const minOdd = Math.min(o1, o2);
  if (minOdd < EXTREME_ODD_THRESHOLD) {
    return `Amichevole con favorita nettissima (quota ${minOdd.toFixed(2)}): le squadre spesso schierano riserve, affidabilità del pronostico ridotta rispetto a un campionato ufficiale.`;
  }
  return null;
}

// ============================================================
// VALUTAZIONE MERCATO (vinto/perso) — per colorare i risultati in Schedina
// ============================================================
export function evaluateMarketOutcome(market: string, result: string): boolean | null {
  const parts = result.split("-").map((n) => parseInt(n.trim(), 10));
  if (parts.length !== 2 || parts.some((n) => isNaN(n))) return null;
  const [home, away] = parts;
  const total = home + away;
  const m = market.trim().toUpperCase().replace(/\s+/g, "");

  if (m.includes("+")) {
    const results = market.toUpperCase().split("+").map((p) => evaluateMarketOutcome(p.trim(), result));
    if (results.some((r) => r === null)) return null;
    return results.every((r) => r === true);
  }

  if (m === "1") return home > away;
  if (m === "X") return home === away;
  if (m === "2") return away > home;
  if (m === "1X" || m === "DC1X") return home >= away;
  if (m === "X2" || m === "DCX2") return away >= home;
  if (m === "12" || m === "DC12") return home !== away;

  const overMatch = m.match(/^O(?:VER)?(\d+(?:\.\d+)?)/);
  if (overMatch) return total > parseFloat(overMatch[1]);
  const underMatch = m.match(/^U(?:NDER)?(\d+(?:\.\d+)?)/);
  if (underMatch) return total < parseFloat(underMatch[1]);

  if (m === "GG" || m === "BTTS") return home > 0 && away > 0;
  if (m === "NG" || m === "NOBTTS") return home === 0 || away === 0;

  if (m.includes("MG") && m.includes("2-4")) {
    if (m.includes("CASA")) return home >= 2 && home <= 4;
    if (m.includes("OSPITE")) return away >= 2 && away <= 4;
    return total >= 2 && total <= 4;
  }

  return null;
}


// ============================================================
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

const _OPPOSITES: [string, string][] = [
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


/**
 * Quanti sistemi POTEVANO esprimersi su questo mercato.
 *
 * Il motore strutturale e l'IA ricevono l'intero catalogo, quindi valutano
 * tutto. L'euristica PRE no: ragiona sulle quote reali del bookmaker, e per i
 * multigol semplici un prezzo non esiste. Su quei mercati si astiene, e non
 * deve pesare come un voto contrario.
 */
function eligibleSystemsFor(market: string, preEligible: Set<string> | null): number {
  if (!preEligible) return 3;                       // nessuna informazione: come prima
  return preEligible.has(normalizeMarket(market)) ? 3 : 2;
}

// ============================================================================
// NOTA SCENARIO 1X2 — richiesta da Rossi il 09/09.
// Calcolo SEPARATO e di sola lettura: non tocca ne' alimenta il verdetto
// finale, il motore, l'IA o lo storico. Serve solo a mostrare in alto, come
// promemoria, lo scenario 1X2 della partita e i mercati "da manuale" indicati
// per quello scenario, usando le quote gia' presenti a sistema.
// Classificazione per FORMA (ordine tra le tre quote), non per soglie fisse:
// vedi conversazione del 09/09 per la derivazione completa.
// ============================================================================
export type ScenarioNote = {
  scenario: "Equilibrio" | "Progressione" | "Gap Tecnico";
  favorita?: "1" | "2";
  markets: string[];
};

export function getScenarioNote(odds: Odds): ScenarioNote | null {
  const q1 = odds.odd_1, qx = odds.odd_X, q2 = odds.odd_2;
  if (q1 == null || qx == null || q2 == null) return null;

  const gg = odds.odd_GG;
  const o25 = odds.odd_O25;

  // ==========================================================================
  // 15/09/2026 — RISCRITTA SU PALETTI ASSOLUTI (specifica di Rossi).
  //
  // Prima classificava per POSIZIONE RELATIVA: "Equilibrio" se la X era la piu'
  // alta delle tre, altrimenti Progressione/Gap secondo l'ordine
  // favorita < X < sfavorita. Conseguenza: una partita con 1=2,62 X=3,27
  // 2=3,91 finiva in "Progressione" pur non avendo nessuna favorita vera.
  //
  // La discriminante ora e' UNA SOLA: esiste una favorita sotto quota 2,00?
  //
  //   NO  -> EQUILIBRIO. Valgono le regole di equilibrio anche con 1 e 2 a 4:
  //          se nessuno e' favorito, la partita e' in equilibrio, punto.
  //   SI  -> conta dove sta la X:
  //            X da 4,00 in su  -> GAP TECNICO   (es. 1=1,80 X=4,00 2=4,30)
  //            X sotto 4,00     -> PROGRESSIONE  (es. 1=1,95 X=3,40 2=3,80)
  //
  // Cosi' non restano buchi (ogni partita cade in una categoria) ne'
  // sovrapposizioni (le condizioni si escludono a vicenda). La versione
  // descritta a voce ne aveva entrambi: 1=4,93 X=4,08 2=2,02 rientrava sia in
  // Equilibrio sia in Gap, e una quota di esattamente 2,00 non rientrava in
  // nessuna delle tre.
  //
  // DUE SCELTE CHE HO PRESO IO, segnalate a Rossi il 15/09:
  //  - equilibrio non controlla la X. Con entrambe sopra 2,00 e X sotto 2,99
  //    (partita bloccata, pareggio molto probabile) resta equilibrio: e' il
  //    caso piu' equilibrato che esista.
  //  - favorita sotto 2,00 con X sotto 3,00 -> Progressione. Combinazione che
  //    in pratica non si verifica (una favorita a 1,50 implica un pareggio
  //    intorno a 4), ma meglio coperta che lasciata scoperta.
  //
  // Resta un calcolo di sola lettura: non tocca il verdetto, il motore, l'IA
  // o lo storico.
  // ==========================================================================
  const SOGLIA_FAVORITA = 2.00;
  const SOGLIA_GAP = 4.00;

  const favorita: "1" | "2" | null =
    q1 < SOGLIA_FAVORITA && q1 <= q2 ? "1" :
    q2 < SOGLIA_FAVORITA && q2 < q1 ? "2" :
    null;

  if (!favorita) {
    let markets: string[];
    if (gg != null && o25 != null && gg < 1.5 && o25 < 1.5) {
      markets = ["MG 3-6 totali (equilibrio con gol molto probabili)"];
    } else if (gg != null && o25 != null && gg < 1.8 && o25 < 1.8) {
      markets = ["GG", "Over 2,5"];
    } else {
      markets = ["MG 2-4 totali (GG/Over fuori soglia: fallback su multigol)"];
    }
    return { scenario: "Equilibrio", markets };
  }

  const casaOspite = favorita === "1"
    ? { fav: "CASA", sfav: "OSPITE" }
    : { fav: "OSPITE", sfav: "CASA" };

  if (qx >= SOGLIA_GAP) {
    return {
      scenario: "Gap Tecnico",
      favorita,
      markets: [
        `${favorita} fisso`,
        "GG + Over 2,5 (combo)",
        `${favorita} AH -0,75`,
      ],
    };
  }

  return {
    scenario: "Progressione",
    favorita,
    markets: [
      `MC ${casaOspite.fav} (1-3) + MC ${casaOspite.sfav} (0-2)`,
      `${favorita} DNB oppure ${favorita} AH +0,75`,
    ],
  };
}

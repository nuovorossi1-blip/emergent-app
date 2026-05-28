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
  marketStats: () => req<{ family: string; market: string; wins: number; total: number; win_rate: number }[]>("/ml/stats"),
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
    return res.json() as Promise<{ inserted: number; updated: number; skipped: number; total_parsed: number }>;
  },
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
    push("MG 2-4", Math.max(1.40, (oO15 + oU35) / 2), "RANGE_CONTROLLATO");
  }
  // GG + O1.5 combo
  if (oO25 <= 1.85 && oGG <= 1.85) push("GG + O1.5", Math.max(oGG, oO15), "OFFENSIVA_PULITA");
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
function normalizeMarket(m: string): string {
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

export type RankedPick = {
  market: string;
  odd: number;
  family: string;
  win_rate: number | null;   // null = no historical data
  total: number;             // sample size
  source: "pre+ai" | "pre" | "ai";  // concordance flag
  boost: number;             // score for ranking
};

/**
 * Build the FINAL ranked list combining pre-pronostic family + LLM markets,
 * with win-rate (when sample is reliable) and concordance BOOST.
 *
 * Rules applied:
 *  - quote < 1.40 → escluso
 *  - concordanza pre+AI = boost massimo (+0.30)
 *  - win_rate aggiunge fino a +1.00 (se ≥3 risultati storici)
 *  - quote più sicure (basse) leggermente favorite a parità
 */
export function rankPicks(
  preFamily: Candidate[],
  llmMarkets: string[],
  stats: { market: string; win_rate: number; total: number; family: string }[] = [],
): RankedPick[] {
  const norm = (m: string) => normalizeMarket(m);
  const statsByMarket = new Map<string, { rate: number; total: number }>();
  for (const s of stats) {
    statsByMarket.set(norm(s.market), { rate: s.win_rate, total: s.total });
  }
  const llmSet = new Set(llmMarkets.map(norm));

  // Build candidates from both sources (union)
  const map = new Map<string, RankedPick>();
  for (const c of preFamily) {
    const k = norm(c.market);
    const st = statsByMarket.get(k);
    map.set(k, {
      market: c.market,
      odd: c.odd,
      family: c.family,
      win_rate: st && st.total >= 3 ? st.rate : null,
      total: st?.total || 0,
      source: llmSet.has(k) ? "pre+ai" : "pre",
      boost: 0,
    });
  }
  for (const lm of llmMarkets) {
    const k = norm(lm);
    if (map.has(k)) continue;
    const st = statsByMarket.get(k);
    map.set(k, {
      market: lm,
      odd: 0,  // unknown from pre side, only AI suggests
      family: "AI_ONLY",
      win_rate: st && st.total >= 3 ? st.rate : null,
      total: st?.total || 0,
      source: "ai",
      boost: 0,
    });
  }

  // Calculate boost score
  const out: RankedPick[] = [];
  for (const p of map.values()) {
    let score = 0;
    if (p.source === "pre+ai") score += 0.30;       // concordanza
    if (p.win_rate !== null) score += (p.win_rate / 100);   // win-rate fino a +1.00
    if (p.odd > 0 && p.odd < 2.00) score += 0.10;   // quota credibile
    p.boost = score;
    out.push(p);
  }
  // Ordina per boost desc, poi per quota asc (più sicura prima)
  out.sort((a, b) => b.boost - a.boost || (a.odd || 99) - (b.odd || 99));
  return out;
}

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

/**
 * Quick rule-based pre-prediction following Book guidelines.
 * Returns the most probable market label + the odd value, NO AI call.
 */
export function quickPrediction(odds: Odds): { market: string; odd: number; family: string } | null {
  const o = odds || {};
  const get = (k: OddsKey, def = Infinity) => (o[k] ?? def) as number;
  const o1 = get("odd_1"), oX = get("odd_X"), o2 = get("odd_2");
  const o1X = get("odd_1X"), oX2 = get("odd_X2"), o12 = get("odd_12");
  const oO15 = get("odd_O15"), oU15 = get("odd_U15");
  const oO25 = get("odd_O25"), oU25 = get("odd_U25");
  const oO35 = get("odd_O35"), oU35 = get("odd_U35");
  const oGG = get("odd_GG"), oNG = get("odd_NG");

  // 1) FAVORITA NETTA — quota ≤ 1.50 → 1 o 2 secco
  if (o1 <= 1.50 && o1 < o2) return { market: "1", odd: o1, family: "DOMINANZA" };
  if (o2 <= 1.50 && o2 < o1) return { market: "2", odd: o2, family: "DOMINANZA" };

  // 2) RANGE CONTROLLATO — pavimento 2 (O1.5 basso) + tetto 3-4 (U3.5 basso) + GG buono
  if (oO15 <= 1.40 && oU35 <= 1.40 && oGG <= 1.85) {
    return { market: "MG 2-4", odd: Math.max(1.30, (oO15 + oU35) / 2), family: "RANGE_CONTROLLATO" };
  }

  // 3) OFFENSIVA PULITA — O2.5 e GG entrambe basse
  if (oO25 <= 1.65 && oGG <= 1.75) {
    return { market: "GG + O1.5", odd: Math.max(oGG, oO15), family: "OFFENSIVA_PULITA" };
  }

  // 4) CHIUSA PROTETTA — U3.5 molto basso, U2.5 basso
  if (oU35 <= 1.20 && oU25 <= 1.70) {
    return { market: "U3.5", odd: oU35, family: "CHIUSA_PROTETTA" };
  }

  // 5) GOAL probabile (forte propensione offensiva entrambe)
  if (oGG <= 1.65) return { market: "GG", odd: oGG, family: "OFFENSIVA" };

  // 6) Over 1.5 quando quota molto bassa
  if (oO15 <= 1.30) return { market: "O1.5", odd: oO15, family: "RANGE_CONTROLLATO" };

  // 7) Over 2.5 quando favorita chiara
  if (oO25 <= 1.75) return { market: "O2.5", odd: oO25, family: "OFFENSIVA" };

  // 8) Doppia chance per favorita non netta (quota 1 o 2 tra 1.51 e 1.85)
  if (o1 > 1.50 && o1 <= 1.85 && o1X <= 1.40) return { market: "1X", odd: o1X, family: "DOMINANZA_TETTO" };
  if (o2 > 1.50 && o2 <= 1.85 && oX2 <= 1.40) return { market: "X2", odd: oX2, family: "DOMINANZA_TETTO" };

  // 9) Under 3.5 fallback (raramente sopra)
  if (oU35 <= 1.35) return { market: "U3.5", odd: oU35, family: "CHIUSA_PROTETTA" };

  // 10) NoGoal fallback
  if (oNG <= 1.75) return { market: "NG", odd: oNG, family: "CHIUSA_PROTETTA" };

  // 11) Default: 12 (no pareggio) — partite incerte
  if (o12 < Infinity) return { market: "12", odd: o12, family: "INSTABILE" };

  return null;
}

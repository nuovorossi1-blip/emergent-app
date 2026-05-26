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
  predict: (id: string) => req<Prediction>(`/matches/${id}/predict`, { method: "POST" }),
  setResult: (id: string, result: string) =>
    req<{ ok: boolean }>(`/matches/${id}/result`, {
      method: "POST",
      body: JSON.stringify({ result }),
    }),
  bulkResults: (items: { id: string; result: string }[]) =>
    req<{ updated: number }>(`/results/bulk`, {
      method: "POST",
      body: JSON.stringify({ items }),
    }),
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

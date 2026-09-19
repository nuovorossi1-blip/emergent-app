/**
 * Cache globale a livello modulo: persiste finché l'app vive,
 * anche quando le schermate vengono smontate dall'expo-router.
 *
 * Strategia: stale-while-revalidate.
 *  - getCachedMatches(): ritorna immediatamente la cache se presente (fresca o stale)
 *  - isStale(): indica se serve rifetchare in background
 *  - setCachedMatches(): aggiorna dopo il fetch
 *
 * TTL "fresh" = 5 minuti (dopo serve refresh in background, ma la UI mostra subito i dati cached)
 */
import { Match } from "@/src/api";

const FRESH_TTL_MS = 5 * 60 * 1000; // 5 minuti

const matchesByDay = new Map<string, { matches: Match[]; ts: number }>();
let daysSnapshot: { days: string[]; ts: number } | null = null;
let marketStatsSnapshot: { stats: any[]; ts: number } | null = null;

export const matchesCache = {
  get(day: string): Match[] | null {
    const entry = matchesByDay.get(day);
    return entry ? entry.matches : null;
  },
  isStale(day: string): boolean {
    const entry = matchesByDay.get(day);
    if (!entry) return true;
    return Date.now() - entry.ts > FRESH_TTL_MS;
  },
  set(day: string, matches: Match[]) {
    matchesByDay.set(day, { matches, ts: Date.now() });
  },
  invalidate(day?: string) {
    if (day) matchesByDay.delete(day);
    else matchesByDay.clear();
  },
};

export const daysCache = {
  get(): string[] | null {
    return daysSnapshot ? daysSnapshot.days : null;
  },
  isStale(): boolean {
    if (!daysSnapshot) return true;
    return Date.now() - daysSnapshot.ts > FRESH_TTL_MS;
  },
  set(days: string[]) {
    daysSnapshot = { days, ts: Date.now() };
  },
  invalidate() {
    daysSnapshot = null;
  },
};

export const marketStatsCache = {
  get(): any[] | null {
    return marketStatsSnapshot ? marketStatsSnapshot.stats : null;
  },
  isStale(): boolean {
    if (!marketStatsSnapshot) return true;
    return Date.now() - marketStatsSnapshot.ts > FRESH_TTL_MS;
  },
  set(stats: any[]) {
    marketStatsSnapshot = { stats, ts: Date.now() };
  },
  invalidate() {
    marketStatsSnapshot = null;
  },
};

let mlStatsSnapshot: { data: any; ts: number } | null = null;
let selectedListSnapshot: { list: any[]; ts: number } | null = null;

export const mlStatsCache = {
  get(): any | null { return mlStatsSnapshot ? mlStatsSnapshot.data : null; },
  isStale(): boolean {
    if (!mlStatsSnapshot) return true;
    return Date.now() - mlStatsSnapshot.ts > FRESH_TTL_MS;
  },
  set(data: any) { mlStatsSnapshot = { data, ts: Date.now() }; },
  invalidate() { mlStatsSnapshot = null; },
};

export const selectedListCache = {
  get(): any[] | null { return selectedListSnapshot ? selectedListSnapshot.list : null; },
  isStale(): boolean {
    if (!selectedListSnapshot) return true;
    return Date.now() - selectedListSnapshot.ts > 30_000; // 30s (cambia frequentemente)
  },
  set(list: any[]) { selectedListSnapshot = { list, ts: Date.now() }; },
  invalidate() { selectedListSnapshot = null; },
};

// ============================================================
// 10/09/2026 — CACHE DEL DETTAGLIO PARTITA
// ============================================================
// Aprire una partita faceva partire SEI richieste (match-detail, ml-stats,
// match-candidates, predict, match-history, odd-settings) e nessuna era in
// cache: riaprire la stessa partita rifaceva tutto da capo, motore compreso.
// Qui teniamo il "pacchetto" completo di una partita, con la stessa strategia
// stale-while-revalidate della home.
//
// La chiave include la soglia di quota perche' l'analisi strutturale dipende
// da quella: cambiando soglia serve un pacchetto diverso, non un aggiornamento
// di quello vecchio.
export type MatchBundle = {
  match: any;
  cands: any;
  struct: any;
  hist: any;
};

const matchBundles = new Map<string, { data: MatchBundle; ts: number }>();
const BUNDLE_TTL_MS = 5 * 60 * 1000;

function bundleKey(id: string, minOdd: number) {
  return `${id}|${minOdd}`;
}

export const matchDetailCache = {
  get(id: string, minOdd: number): MatchBundle | null {
    const e = matchBundles.get(bundleKey(id, minOdd));
    return e ? e.data : null;
  },
  isStale(id: string, minOdd: number): boolean {
    const e = matchBundles.get(bundleKey(id, minOdd));
    if (!e) return true;
    return Date.now() - e.ts > BUNDLE_TTL_MS;
  },
  set(id: string, minOdd: number, data: MatchBundle) {
    matchBundles.set(bundleKey(id, minOdd), { data, ts: Date.now() });
  },
  /** Senza id svuota tutto; con id butta via il pacchetto a TUTTE le soglie. */
  invalidate(id?: string) {
    if (!id) { matchBundles.clear(); return; }
    for (const k of Array.from(matchBundles.keys())) {
      if (k.startsWith(`${id}|`)) matchBundles.delete(k);
    }
  },
};

// Soglia di quota minima: e' una preferenza, cambia solo quando la cambia
// l'utente. Veniva riletta dal server ad ogni apertura di partita, e per di
// piu' arrivava DOPO il primo caricamento, facendo ripartire tutte e cinque
// le chiamate quando la soglia salvata non era 1,40. Ora si legge una volta
// per sessione.
let oddSettingsSnapshot: { min_odd: number; options: number[] } | null = null;

export const oddSettingsCache = {
  get(): { min_odd: number; options: number[] } | null { return oddSettingsSnapshot; },
  set(v: { min_odd: number; options: number[] }) { oddSettingsSnapshot = v; },
};

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

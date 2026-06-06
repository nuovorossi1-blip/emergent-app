import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, RefreshControl, Modal, FlatList, Alert, useWindowDimensions, Platform, BackHandler,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";

import { api, Match, quickPrediction, quickPredictionFamily, rankPicks, pickFinal, RankedPick } from "@/src/api";
import { colors } from "@/src/theme";
import BottomNav from "@/src/components/BottomNav";
import { useBottomNav } from "@/src/components/BottomNavContext";
import { useToast } from "@/src/components/Toast";
import { matchesCache, daysCache, marketStatsCache, selectedListCache } from "@/src/utils/cache";
import { confirmAction } from "@/src/utils/platform";
import { parseLeagueCode } from "@/src/utils/leagues";
import { predictionQueue } from "@/src/utils/predictionQueue";

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function nearestDay(days: string[]): string | null {
  if (!days.length) return null;
  const today = todayISO();
  if (days.includes(today)) return today;
  const future = days.filter((d) => d >= today).sort();
  if (future.length) return future[0];
  return days.slice().sort().reverse()[0];
}
const DAY_SHORT_IT = ["DOM", "LUN", "MAR", "MER", "GIO", "VEN", "SAB"];
const MONTH_LONG_IT = ["GEN", "FEB", "MAR", "APR", "MAG", "GIU", "LUG", "AGO", "SET", "OTT", "NOV", "DIC"];
const MONTH_FULL_IT = ["GENNAIO", "FEBBRAIO", "MARZO", "APRILE", "MAGGIO", "GIUGNO", "LUGLIO", "AGOSTO", "SETTEMBRE", "OTTOBRE", "NOVEMBRE", "DICEMBRE"];
const DAY_FULL_IT = ["DOMENICA", "LUNEDÌ", "MARTEDÌ", "MERCOLEDÌ", "GIOVEDÌ", "VENERDÌ", "SABATO"];

function parseISO(d: string) { const [y, m, dd] = d.split("-").map(Number); return new Date(y, m - 1, dd); }
function fmtDayShort(d: string) { const dt = parseISO(d); const today = todayISO(); if (d === today) return "OGGI"; const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); if (d === `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,"0")}-${String(tomorrow.getDate()).padStart(2,"0")}`) return "DOMANI"; return DAY_SHORT_IT[dt.getDay()]; }
function fmtDayLong(d: string) { const dt = parseISO(d); return `${DAY_FULL_IT[dt.getDay()]} ${dt.getDate()} ${MONTH_FULL_IT[dt.getMonth()]}`; }
function fmtDateBadge(d: string) { const dt = parseISO(d); return `${dt.getDate()} ${MONTH_LONG_IT[dt.getMonth()]} ${String(dt.getFullYear()).slice(2)}`; }

function predLabel(m: Match, stats: { market: string; win_rate: number; total: number; missed?: number; family: string }[] = []): { label: string; isAi: boolean; isConcord: boolean; isCandidate: boolean; isNoBet: boolean; isCorrect: boolean | null } {
  // Build pre-pronostic family + LLM markets list, compute final ranking.
  const fam = quickPredictionFamily(m.odds);
  const llmMarkets: string[] = m.playable_markets?.map((p) => p.market) || (m.main_prediction ? [m.main_prediction] : []);
  const ranked = rankPicks(fam, llmMarkets, stats);
  const { pick, isNoBet } = pickFinal(ranked, llmMarkets);
  const map: Record<string, string> = { "O1.5": "Ov1.5", "O2.5": "Ov2.5", "O3.5": "Ov3.5", "U1.5": "Un1.5", "U2.5": "Un2.5", "U3.5": "Un3.5" };

  // Evaluate "isCorrect": does the chosen market win vs the inserted result?
  let isCorrect: boolean | null = null;
  if (m.result && pick) {
    const parts = m.result.split("-").map((x) => parseInt(x, 10));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      isCorrect = evalLocal(pick.market, parts[0], parts[1]);
    }
  }
  if (isNoBet) return { label: "NO BET", isAi: false, isConcord: false, isCandidate: false, isNoBet: true, isCorrect: null };
  if (pick) {
    const label = map[pick.market] || pick.market;
    return { label, isAi: pick.source !== "pre", isConcord: pick.source === "pre+ai", isCandidate: pick.isCandidate, isNoBet: false, isCorrect };
  }
  // Fallback: lowest 1X2
  const o = m.odds;
  const arr: [string, number?][] = [["1", o.odd_1], ["X", o.odd_X], ["2", o.odd_2]];
  let best = "1X2", low = Infinity;
  for (const [l, v] of arr) if (v && v < low) { low = v; best = l; }
  return { label: best, isAi: false, isConcord: false, isCandidate: false, isNoBet: false, isCorrect: null };
}

/** Local market evaluator (mirror of backend logic for live display) */
function evalLocal(market: string, home: number, away: number): boolean | null {
  const total = home + away;
  const m = market.trim().toUpperCase().replace(/\s+/g, " ");
  if (m === "1") return home > away;
  if (m === "X") return home === away;
  if (m === "2") return away > home;
  if (m === "1X" || m === "DC 1X") return home >= away;
  if (m === "X2" || m === "DC X2") return away >= home;
  if (m === "12" || m === "DC 12") return home !== away;
  const overMatch = m.match(/^OV?\s?(\d\.\d)|^OVER\s?(\d\.\d)/);
  if (overMatch) return total > parseFloat(overMatch[1] || overMatch[2]);
  const underMatch = m.match(/^UN?\s?(\d\.\d)|^UNDER\s?(\d\.\d)/);
  if (underMatch) return total < parseFloat(underMatch[1] || underMatch[2]);
  if (m === "GG") return home > 0 && away > 0;
  if (m === "NG") return home === 0 || away === 0;
  if (m.includes("MG") && m.includes("2-4")) {
    if (m.includes("CASA")) return home >= 2 && home <= 4;
    if (m.includes("OSPITE")) return away >= 2 && away <= 4;
    return total >= 2 && total <= 4;
  }
  // Combo (DC ... + ...)
  if (m.includes("+")) {
    const parts = market.split("+").map((p) => p.trim());
    const results = parts.map((p) => evalLocal(p, home, away));
    if (results.some((r) => r === null)) return null;
    return results.every((r) => r === true);
  }
  return null;
}

// Module-level scroll position cache to restore between navigations
let savedScrollY = 0;

export default function Home() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === "web" && width >= 900;
  const numCols = 1; // forced single-column list also on desktop (user request)
  const bottomNav = useBottomNav();
  const toast = useToast();

  const [matches, setMatches] = useState<Match[]>([]);
  const [days, setDays] = useState<string[]>([]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [calOpen, setCalOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [didInit, setDidInit] = useState(false);
  const [tierFilter, setTierFilter] = useState<"top" | null>(null);
  const [areaFilter, setAreaFilter] = useState<string | null>(null);
  const [countryFilter, setCountryFilter] = useState<string | null>(null);
  const [sortByTime, setSortByTime] = useState(false);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [marketStats, setMarketStats] = useState<{ market: string; win_rate: number; total: number; family: string }[]>([]);
  const [pendingPreds, setPendingPreds] = useState<Set<string>>(new Set());
  const scrollRef = useRef<ScrollView | null>(null);

  // Subscribe to background prediction queue → re-render to show spinners on pending matches
  useEffect(() => {
    const update = () => setPendingPreds(new Set(predictionQueue.pendingIds()));
    update();
    const unsub = predictionQueue.subscribe(update);
    // Poll matches when any prediction is pending → auto-refresh when AI completes
    const interval = setInterval(() => {
      if (predictionQueue.size() > 0) load(selectedDay);
    }, 4000);
    return () => { unsub(); clearInterval(interval); };
  }, []);

  const load = useCallback(async (day: string | null, force = false) => {
    try {
      // STALE-WHILE-REVALIDATE
      // 1) Se cache esiste, mostro subito (snappy!) e poi rifaccio fetch in background.
      // 2) Se cache fresca (<5 min) e !force, salto del tutto il fetch.
      if (day) {
        const cached = matchesCache.get(day);
        if (cached) {
          setMatches(cached);
          setDays(daysCache.get() || []);
          if (marketStatsCache.get()) setMarketStats(marketStatsCache.get() || []);
          if (!force && !matchesCache.isStale(day)) {
            setLoading(false); setRefreshing(false);
            return daysCache.get() || [];
          }
          // stale → continua fetch in background SENZA spinner
          setLoading(false);
        }
      }

      if (day === null) {
        const dsCached = daysCache.get();
        if (dsCached && !daysCache.isStale()) {
          setDays(dsCached);
          setMarketStats(marketStatsCache.get() || []);
          return dsCached;
        }
        const [ds, stats] = await Promise.all([
          api.days(),
          api.marketStats().catch(() => ({ markets: [], family_totals: {} })),
        ]);
        daysCache.set(ds);
        marketStatsCache.set(stats?.markets || []);
        setDays(ds); setMarketStats(stats?.markets || []); return ds;
      }

      const [ms, ds, stats] = await Promise.all([
        api.matches(day),
        api.days(),
        api.marketStats().catch(() => ({ markets: [], family_totals: {} })),
      ]);
      matchesCache.set(day, ms);
      daysCache.set(ds);
      marketStatsCache.set(stats?.markets || []);
      setMatches(ms); setDays(ds); setMarketStats(stats?.markets || []); return ds;
    } catch { return []; } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => {
    if (didInit) return;
    (async () => {
      setLoading(true);
      const ds = await load(null);
      const d = nearestDay(ds);
      if (d) setSelectedDay(d);
      setDidInit(true);
    })();
  }, [didInit, load]);

  // Android back button → conferma uscita app quando si è sulla home
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      Alert.alert(
        "Esci dall'app",
        "Vuoi davvero uscire dall'applicazione?",
        [
          { text: "Annulla", style: "cancel", onPress: () => {} },
          { text: "Esci", style: "destructive", onPress: () => BackHandler.exitApp() },
        ],
        { cancelable: true },
      );
      return true; // blocca il default (chiusura immediata)
    });
    return () => handler.remove();
  }, []);

  useFocusEffect(useCallback(() => {
    if (!didInit) return;
    // Se cache globale fresca per il giorno corrente → no spinner, no fetch
    const day = selectedDay;
    const hasCache = day ? matchesCache.get(day) !== null : false;
    const fresh = day ? !matchesCache.isStale(day) : false;
    if (!hasCache) setLoading(true);
    // Forza show della BottomNav quando entri nella home
    bottomNav.show();
    if (hasCache && fresh) {
      // Mostra istantaneo dalla cache, niente fetch
      setMatches(matchesCache.get(day!) || []);
      setDays(daysCache.get() || []);
      setMarketStats(marketStatsCache.get() || []);
      setLoading(false);
      // restore scroll
      requestAnimationFrame(() => { if (savedScrollY > 0) scrollRef.current?.scrollTo({ y: savedScrollY, animated: false }); });
      return;
    }
    load(day).then(() => {
      // Restore scroll position after data is loaded
      if (savedScrollY > 0) {
        setTimeout(() => {
          scrollRef.current?.scrollTo({ y: savedScrollY, animated: false });
        }, 80);
      }
    });
  }, [selectedDay, load, didInit]));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return matches.filter((m) => {
      const lc = parseLeagueCode(m.manifestazione);
      if (countryFilter && lc.country !== countryFilter) return false;
      if (areaFilter && lc.area !== areaFilter) return false;
      if (tierFilter === "top" && !lc.isTop) return false;
      if (q) {
        const hay = `${m.squadra1} ${m.squadra2} ${m.manifestazione} ${lc.label}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [matches, query, tierFilter, areaFilter, countryFilter]);

  const grouped = useMemo(() => {
    if (sortByTime) {
      // ORARIO mode: flat list ordered chronologically (asc or desc)
      const sorted = [...filtered].sort((a, b) => sortDir === "asc" ? a.time.localeCompare(b.time) : b.time.localeCompare(a.time));
      const arrow = sortDir === "asc" ? "↑ 00:00→23:59" : "↓ 23:59→00:00";
      return sorted.length ? [[`⏱ ORDINE CRONOLOGICO ${arrow}`, sorted] as [string, Match[]]] : [];
    }
    const map = new Map<string, Match[]>();
    for (const m of filtered) {
      if (!map.has(m.manifestazione)) map.set(m.manifestazione, []);
      map.get(m.manifestazione)!.push(m);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered, sortByTime, sortDir]);

  const selectedCount = matches.filter((m) => m.selected).length;
  const toggleSelect = async (m: Match) => {
    const next = !m.selected;
    // 1) UI ottimistica: update locale
    setMatches((arr) => arr.map((x) => x.id === m.id ? { ...x, selected: next } : x));
    // 2) Invalida cache (BottomNav badge + Schedina list)
    selectedListCache.invalidate();
    matchesCache.invalidate(m.day);
    // 3) Toast feedback
    const teams = `${m.casa} vs ${m.ospite}`;
    toast.show(next ? `✓ Aggiunta: ${teams}` : `Rimossa: ${teams}`, next ? "success" : "info");
    // 4) Sync con backend
    try { await api.updateSelection([m.id], next); } catch {}
  };
  const clearAllSelection = () => confirmAction({
    title: "Svuotare selezione?", confirmText: "Svuota", destructive: true,
    onConfirm: async () => {
      // 1) UI ottimistica
      setMatches((arr) => arr.map((x) => ({ ...x, selected: false })));
      // 2) Invalida TUTTE le cache (matches per ogni giorno + selected list)
      selectedListCache.invalidate();
      matchesCache.invalidate(); // clear all days
      // 3) Sync con backend
      try { await api.clearSelection(); } catch {}
      // 4) Force re-fetch del giorno corrente (UI fresca)
      await load(selectedDay, true);
      toast.show("Selezione svuotata", "info");
    },
  });
  const goToToday = () => { const d = nearestDay(days); setSelectedDay(d); setCountryFilter(null); setAreaFilter(null); setQuery(""); setTierFilter(null); };

  // Reset scroll when user actively changes filters or day (NOT when returning from match detail)
  useEffect(() => {
    savedScrollY = 0;
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [selectedDay, query, tierFilter, areaFilter, countryFilter, sortByTime]);

  // Day strip: 5 visible days centered around selectedDay
  const dayStrip = useMemo(() => {
    if (!days.length) return [];
    const idx = selectedDay ? days.indexOf(selectedDay) : 0;
    const start = Math.max(0, Math.min(days.length - 5, idx - 1));
    return days.slice(start, start + 5);
  }, [days, selectedDay]);

  // Areas + countries from current matches
  const availableAreas = useMemo(() => Array.from(new Set(matches.map(m => parseLeagueCode(m.manifestazione).area))).sort(), [matches]);
  const availableCountries = useMemo(() => Array.from(new Set(matches.map(m => parseLeagueCode(m.manifestazione).country).filter(Boolean) as string[])).sort(), [matches]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Ionicons name="trophy" size={20} color={colors.primary} />
          <Text style={styles.title}>ScoreBlast</Text>
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TouchableOpacity testID="btn-reset" onPress={goToToday} style={styles.resetBtn}>
            <Ionicons name="refresh" size={14} color={colors.text} />
            <Text style={styles.resetBtnTxt}>RESET</Text>
          </TouchableOpacity>
          <TouchableOpacity testID="open-strumenti" onPress={() => router.push("/strumenti")} style={styles.menuBtn}>
            <Text style={styles.menuBtnTxt}>Strumenti</Text>
            <Ionicons name="chevron-down" size={14} color={colors.text} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={isDesktop ? styles.desktopWrap : { flex: 1 }}>

      {/* Day strip */}
      <View style={styles.dayStrip}>
        {dayStrip.map((d) => {
          const dt = parseISO(d); const active = d === selectedDay;
          if (active) {
            return (
              <TouchableOpacity key={d} onPress={() => setSelectedDay(d)} style={styles.dayActive} testID={`day-${d}`}>
                <LinearGradient colors={[colors.primaryLight, colors.primaryDark]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.dayActiveGrad}>
                  <Text style={styles.dayLabelActive}>{fmtDayShort(d)}</Text>
                  <Text style={styles.dayNumActive}>{dt.getDate()}</Text>
                </LinearGradient>
              </TouchableOpacity>
            );
          }
          return (
            <TouchableOpacity key={d} onPress={() => setSelectedDay(d)} style={styles.dayInactive} testID={`day-${d}`}>
              <Text style={styles.dayLabel}>{fmtDayShort(d)}</Text>
              <Text style={styles.dayNum}>{dt.getDate()}</Text>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity onPress={() => setCalOpen(true)} style={styles.calBtn} testID="open-calendar">
          <Ionicons name="calendar" size={18} color={colors.primary} />
          <View>
            <Text style={styles.calMain}>{selectedDay ? fmtDayLong(selectedDay).split(" ")[0] : "—"}</Text>
            <Text style={styles.calSub}>{selectedDay ? fmtDayLong(selectedDay).split(" ").slice(1).join(" ") : ""}</Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* Filter row */}
      <View style={styles.filterRow}>
        <TouchableOpacity onPress={() => setShowSearch(!showSearch)} style={styles.searchPill} testID="filter-search">
          <Ionicons name="search" size={16} color={colors.textMuted} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setFiltersOpen(true)} style={styles.filterPill} testID="filter-open">
          <Text style={styles.filterPillTxt}>FILTRI</Text>
          <Ionicons name="options-outline" size={14} color={colors.text} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setTierFilter(tierFilter === "top" ? null : "top")} style={[styles.filterPill, tierFilter === "top" && styles.filterPillActive]} testID="filter-top">
          {tierFilter === "top" ? (
            <LinearGradient colors={[colors.primaryLight, colors.primaryDark]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.filterPillGrad}>
              <Text style={[styles.filterPillTxt, { color: "#FFF" }]}>PRINCIPALI</Text>
            </LinearGradient>
          ) : <Text style={styles.filterPillTxt}>PRINCIPALI</Text>}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setSortByTime(!sortByTime)} style={[styles.filterPill, sortByTime && { borderColor: colors.primary }]} testID="filter-time">
          <Ionicons name="time-outline" size={14} color={sortByTime ? colors.primary : colors.text} />
          <Text style={[styles.filterPillTxt, sortByTime && { color: colors.primary }]}>ORARIO</Text>
        </TouchableOpacity>
        {sortByTime && (
          <TouchableOpacity onPress={() => setSortDir(sortDir === "asc" ? "desc" : "asc")} style={[styles.filterPill, { paddingHorizontal: 12, borderColor: colors.primary }]} testID="sort-dir-btn">
            <Ionicons name={sortDir === "asc" ? "arrow-up" : "arrow-down"} size={14} color={colors.primary} />
            <Text style={[styles.filterPillTxt, { color: colors.primary }]}>{sortDir === "asc" ? "ASC" : "DESC"}</Text>
          </TouchableOpacity>
        )}
      </View>

      {showSearch && (
        <View style={styles.searchBar}>
          <Ionicons name="search" size={14} color={colors.textMuted} />
          <TextInput placeholder="Cerca squadra o lega" placeholderTextColor={colors.textDim} value={query} onChangeText={setQuery} style={styles.searchInput} testID="search-input" autoFocus />
          {query.length > 0 && <TouchableOpacity onPress={() => setQuery("")}><Ionicons name="close" size={16} color={colors.textMuted} /></TouchableOpacity>}
        </View>
      )}

      {/* Counter row */}
      <View style={styles.countRow}>
        <Text style={styles.countTxt}><Text style={styles.countNum}>{filtered.length}</Text> partite <Text style={styles.countSep}>/</Text> <Text style={styles.countNum}>{matches.length}</Text> totali</Text>
        {selectedCount > 0 && (
          <TouchableOpacity onPress={clearAllSelection} style={styles.svuotaBtn} testID="clear-selection">
            <Ionicons name="trash-outline" size={12} color={colors.danger} />
            <Text style={styles.svuotaTxt}>Svuota</Text>
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : matches.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="document-text-outline" size={56} color={colors.textDim} />
          <Text style={styles.emptyTxt}>Nessuna partita per questo giorno</Text>
          <TouchableOpacity onPress={() => router.push("/strumenti")} style={styles.emptyBtn}><Text style={styles.emptyBtnTxt}>Carica Excel</Text></TouchableOpacity>
        </View>
      ) : (
        <ScrollView ref={scrollRef} onScroll={(e) => { const y = e.nativeEvent.contentOffset.y; savedScrollY = y; bottomNav.handleScroll(y); }} scrollEventThrottle={16} decelerationRate="fast" keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.list, isDesktop && { paddingHorizontal: 24 }]} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { savedScrollY = 0; setRefreshing(true); load(selectedDay, true); }} tintColor={colors.primary} />}>
          {grouped.map(([league, items]) => {
            const lc = parseLeagueCode(league);
            return (
              <View key={league} style={styles.leagueBlock}>
                <View style={styles.leagueHeader}>
                  <Ionicons name="football-outline" size={14} color={colors.primary} />
                  <Text style={styles.leagueTxt}>{league}</Text>
                  {lc.country && <Text style={styles.leagueCountry}>({lc.label.toUpperCase()})</Text>}
                  <View style={{ flex: 1 }} />
                  <Text style={styles.leagueCount}>{items.length}</Text>
                </View>
                <View style={isDesktop ? styles.cardsGrid : undefined}>
                  {items.map((m) => {
                    const pred = predLabel(m, marketStats);
                    const resParts = (m.result || "").split("-");
                    const hasRes = resParts.length === 2 && !isNaN(+resParts[0]) && !isNaN(+resParts[1]);
                    return (
                      <TouchableOpacity key={m.id} testID={`match-${m.id}`} onPress={() => router.push(`/match/${m.id}`)} onLongPress={() => toggleSelect(m)} activeOpacity={0.85} style={[styles.card, m.selected && styles.cardSelected, isDesktop && { width: `${100 / numCols - 1}%` }]}>
                        <TouchableOpacity onPress={() => toggleSelect(m)} style={[styles.check, m.selected && styles.checkOn]} hitSlop={10} testID={`select-${m.id}`}>
                          {m.selected && <Ionicons name="checkmark" size={14} color="#FFF" />}
                        </TouchableOpacity>
                        <View style={styles.teams}>
                          {sortByTime && (
                            <Text style={styles.teamLeagueTag} numberOfLines={1}>
                              {parseLeagueCode(m.manifestazione).shortLabel}
                            </Text>
                          )}
                          <Text style={styles.teamTxt} numberOfLines={1}>{m.squadra1.toUpperCase()}</Text>
                          <Text style={styles.teamTxt} numberOfLines={1}>{m.squadra2.toUpperCase()}</Text>
                        </View>
                        <View style={styles.timeCol}>
                          <Text style={styles.timeDate}>{fmtDateBadge(m.day)}</Text>
                          <Text style={styles.timeNum}>{m.time}</Text>
                        </View>
                        <View style={styles.predCol}>
                          <LinearGradient
                            colors={
                              pred.isCorrect === true ? ["#10B981", "#059669"] :
                              pred.isCorrect === false ? ["#EF4444", "#DC2626"] :
                              pred.isNoBet ? ["#71717A", "#52525B"] :
                              pred.isCandidate ? ["#F59E0B", "#D97706"] :
                              pred.isConcord ? ["#60A5FA", "#3B82F6"] :
                              [colors.primaryLight, colors.primaryDark]
                            }
                            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                            style={styles.predBadge}
                          >
                            {pred.isCorrect === true && <Ionicons name="checkmark-circle" size={11} color="#FFF" style={{ marginRight: 2 }} />}
                            {pred.isCorrect === false && <Ionicons name="close-circle" size={11} color="#FFF" style={{ marginRight: 2 }} />}
                            {pred.isConcord && pred.isCorrect === null && <Ionicons name="checkmark-done" size={10} color="#FFF" style={{ marginRight: 2 }} />}
                            {pred.isCandidate && <Ionicons name="bulb" size={10} color="#FFF" style={{ marginRight: 2 }} />}
                            {pred.isNoBet && <Ionicons name="close" size={10} color="#FFF" style={{ marginRight: 2 }} />}
                            <Text style={styles.predTxt}>{pred.label}</Text>
                            {hasRes && (
                              <>
                                <View style={styles.predSep} />
                                <View>
                                  <Text style={styles.resNum}>{resParts[0]}</Text>
                                  <Text style={styles.resNum}>{resParts[1]}</Text>
                                </View>
                              </>
                            )}
                          </LinearGradient>
                          {m.main_prediction && !pred.isConcord && !pred.isNoBet ? (
                            <View style={styles.aiBadge}>
                              <Ionicons name="sparkles" size={9} color={colors.aiText} />
                              <Text style={styles.aiBadgeTxt} numberOfLines={1}>{m.main_prediction}</Text>
                            </View>
                          ) : null}
                          {pendingPreds.has(m.id) ? (
                            <View style={[styles.aiBadge, { backgroundColor: colors.aiBg }]}>
                              <ActivityIndicator size="small" color={colors.aiText} />
                              <Text style={styles.aiBadgeTxt} numberOfLines={1}>AI...</Text>
                            </View>
                          ) : null}
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            );
          })}
          <View style={{ height: 100 }} />
        </ScrollView>
      )}
      </View>

      <BottomNav />

      {/* Calendar modal */}
      <Modal visible={calOpen} transparent animationType="fade" onRequestClose={() => setCalOpen(false)}>
        <TouchableOpacity style={styles.modalBg} activeOpacity={1} onPress={() => setCalOpen(false)}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Seleziona Giorno</Text>
            <FlatList data={days} keyExtractor={(it) => it} initialScrollIndex={Math.max(0, selectedDay ? days.indexOf(selectedDay) : 0)} getItemLayout={(_, i) => ({ length: 48, offset: 48 * i, index: i })} onScrollToIndexFailed={() => {}} renderItem={({ item }) => (
              <TouchableOpacity onPress={() => { setSelectedDay(item); setCalOpen(false); }} style={[styles.dayItem, item === selectedDay && styles.dayItemActive]} testID={`cal-${item}`}>
                <Text style={[styles.dayItemTxt, item === selectedDay && { color: "#FFF" }]}>{fmtDayLong(item)}</Text>
              </TouchableOpacity>
            )} />
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Filters modal */}
      <Modal visible={filtersOpen} transparent animationType="slide" onRequestClose={() => setFiltersOpen(false)}>
        <TouchableOpacity style={styles.modalBg} activeOpacity={1} onPress={() => setFiltersOpen(false)}>
          <View style={[styles.modalBox, { maxHeight: "85%" }]}>
            <Text style={styles.modalTitle}>Filtri</Text>
            <ScrollView>
              <Text style={styles.filtersSection}>AREA GEOGRAFICA</Text>
              <View style={styles.chipRow}>
                <TouchableOpacity onPress={() => setAreaFilter(null)} style={[styles.chip, !areaFilter && styles.chipActive]}><Text style={[styles.chipTxt, !areaFilter && { color: "#FFF" }]}>TUTTE</Text></TouchableOpacity>
                {availableAreas.map(a => (
                  <TouchableOpacity key={a} onPress={() => setAreaFilter(a === areaFilter ? null : a)} style={[styles.chip, areaFilter === a && styles.chipActive]} testID={`area-${a}`}>
                    <Text style={[styles.chipTxt, areaFilter === a && { color: "#FFF" }]}>{a.toUpperCase()}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.filtersSection}>NAZIONE</Text>
              <View style={styles.chipRow}>
                <TouchableOpacity onPress={() => setCountryFilter(null)} style={[styles.chip, !countryFilter && styles.chipActive]}><Text style={[styles.chipTxt, !countryFilter && { color: "#FFF" }]}>TUTTE</Text></TouchableOpacity>
                {availableCountries.map(c => (
                  <TouchableOpacity key={c} onPress={() => setCountryFilter(c === countryFilter ? null : c)} style={[styles.chip, countryFilter === c && styles.chipActive]} testID={`country-${c}`}>
                    <Text style={[styles.chipTxt, countryFilter === c && { color: "#FFF" }]}>{c.toUpperCase()}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
            <TouchableOpacity onPress={() => setFiltersOpen(false)} style={styles.applyBtn}><Text style={styles.applyBtnTxt}>APPLICA</Text></TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: colors.text, fontSize: 22, fontWeight: "900", letterSpacing: -0.5 },
  resetBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.surfaceHi, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  resetBtnTxt: { color: colors.text, fontSize: 11, fontWeight: "900", letterSpacing: 0.5 },
  menuBtn: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.surfaceHi, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 },
  menuBtnTxt: { color: colors.text, fontSize: 13, fontWeight: "600" },
  desktopWrap: { flex: 1, maxWidth: 1400, width: "100%", alignSelf: "center" },
  dayStrip: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, gap: 12, justifyContent: "space-between" },
  dayInactive: { alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  dayLabel: { color: colors.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 0.5 },
  dayNum: { color: colors.text, fontSize: 22, fontWeight: "900", marginTop: 2 },
  dayActive: { borderRadius: 14, overflow: "hidden" },
  dayActiveGrad: { paddingHorizontal: 14, paddingVertical: 8, alignItems: "center", borderRadius: 14 },
  dayLabelActive: { color: "#FFF", fontSize: 11, fontWeight: "900", letterSpacing: 0.5 },
  dayNumActive: { color: "#FFF", fontSize: 22, fontWeight: "900" },
  calBtn: { flexDirection: "row", alignItems: "center", gap: 6 },
  calMain: { color: colors.primary, fontSize: 10, fontWeight: "900", letterSpacing: 0.5 },
  calSub: { color: colors.primary, fontSize: 12, fontWeight: "800" },
  filterRow: { flexDirection: "row", paddingHorizontal: 16, gap: 8, alignItems: "center", paddingBottom: 8 },
  searchPill: { width: 40, height: 40, borderRadius: 999, backgroundColor: colors.surfaceHi, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  filterPill: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.surfaceHi, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 999, overflow: "hidden" },
  filterPillActive: { borderColor: colors.primary, padding: 0 },
  filterPillGrad: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 999 },
  filterPillTxt: { color: colors.text, fontSize: 11, fontWeight: "900", letterSpacing: 0.5 },
  searchBar: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginBottom: 8, backgroundColor: colors.surfaceHi, borderRadius: 10, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 8 },
  searchInput: { flex: 1, color: colors.text, fontSize: 14 },
  countRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingVertical: 8 },
  countTxt: { color: colors.textMuted, fontSize: 13 },
  countNum: { color: colors.text, fontWeight: "900" },
  countSep: { color: colors.textDim },
  svuotaBtn: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(239,68,68,0.10)", borderWidth: 1, borderColor: "rgba(239,68,68,0.4)", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
  svuotaTxt: { color: colors.danger, fontSize: 11, fontWeight: "800" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14 },
  emptyTxt: { color: colors.textMuted, fontSize: 15 },
  emptyBtn: { backgroundColor: colors.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 999 },
  emptyBtnTxt: { color: "#FFF", fontWeight: "800" },
  list: { padding: 16, paddingBottom: 130, gap: 8 },
  leagueBlock: { marginBottom: 16 },
  leagueHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  leagueTxt: { color: colors.primary, fontSize: 14, fontWeight: "900", letterSpacing: 1, textTransform: "uppercase" },
  leagueCountry: { color: colors.textMuted, fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },
  leagueCount: { color: colors.textMuted, fontSize: 12, fontWeight: "800" },
  cardsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  card: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.surface, borderRadius: 14, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.border },
  cardSelected: { borderColor: colors.primary, backgroundColor: "rgba(255,140,66,0.06)" },
  check: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.borderLight, alignItems: "center", justifyContent: "center" },
  checkOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  teams: { flex: 1, gap: 2 },
  teamTxt: { color: colors.text, fontSize: 13, fontWeight: "900", letterSpacing: 0.5 },
  teamLeagueTag: { color: colors.primary, fontSize: 9, fontWeight: "900", letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 3 },
  timeCol: { alignItems: "center", paddingHorizontal: 4 },
  timeDate: { color: colors.textDim, fontSize: 10, fontWeight: "700" },
  timeNum: { color: colors.text, fontSize: 18, fontWeight: "900", marginTop: 2 },
  predBadge: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, minWidth: 90 },
  predCol: { alignItems: "flex-end", gap: 4 },
  aiBadge: { flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: colors.aiBg, borderWidth: 1, borderColor: "rgba(96,165,250,0.35)", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, maxWidth: 120 },
  aiBadgeTxt: { color: colors.aiText, fontSize: 9, fontWeight: "900", letterSpacing: 0.3 },
  predTxt: { color: "#FFF", fontSize: 16, fontWeight: "900" },
  predSep: { width: 1, height: 32, backgroundColor: "rgba(255,255,255,0.4)" },
  resNum: { color: "#FFF", fontSize: 14, fontWeight: "900", lineHeight: 16 },
  modalBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "center", alignItems: "center", padding: 24 },
  modalBox: { backgroundColor: colors.surface, borderRadius: 14, padding: 16, width: "100%", maxHeight: "70%", borderWidth: 1, borderColor: colors.border },
  modalTitle: { color: colors.text, fontSize: 16, fontWeight: "900", marginBottom: 12 },
  dayItem: { paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10, marginBottom: 4, backgroundColor: colors.surfaceHi },
  dayItemActive: { backgroundColor: colors.primary },
  dayItemTxt: { color: colors.text, fontSize: 13, fontWeight: "700", letterSpacing: 0.5 },
  filtersSection: { color: colors.primary, fontSize: 11, fontWeight: "900", letterSpacing: 1, marginTop: 12, marginBottom: 8 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { backgroundColor: colors.surfaceHi, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipTxt: { color: colors.text, fontSize: 11, fontWeight: "800", letterSpacing: 0.5 },
  applyBtn: { backgroundColor: colors.primary, paddingVertical: 12, borderRadius: 10, marginTop: 12, alignItems: "center" },
  applyBtnTxt: { color: "#FFF", fontWeight: "900", letterSpacing: 1 },
});

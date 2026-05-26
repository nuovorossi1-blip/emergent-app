import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, RefreshControl, Modal, FlatList, Alert, useWindowDimensions, Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";

import { api, Match, quickPrediction } from "@/src/api";
import { colors } from "@/src/theme";
import BottomNav from "@/src/components/BottomNav";
import { OddBadge } from "@/src/components/OddBadge";
import { confirmAction } from "@/src/utils/platform";

function bestSign(m: Match): { label: string; value?: number } {
  const q = quickPrediction(m.odds);
  if (q) return { label: q.market, value: q.odd };
  const candidates: [string, number | undefined][] = [
    ["1", m.odds.odd_1], ["X", m.odds.odd_X], ["2", m.odds.odd_2],
  ];
  let best: { label: string; value?: number } = { label: "1X2" };
  let lowest = Infinity;
  for (const [l, v] of candidates) {
    if (v && v < lowest) { lowest = v; best = { label: l, value: v }; }
  }
  return best;
}

function fmtDay(d: string) {
  const [y, m, day] = d.split("-").map(Number);
  const months = ["GEN", "FEB", "MAR", "APR", "MAG", "GIU", "LUG", "AGO", "SET", "OTT", "NOV", "DIC"];
  return `${day} ${months[m - 1]} ${String(y).slice(2)}`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nearestDay(days: string[]): string | null {
  if (!days.length) return null;
  const today = todayISO();
  if (days.includes(today)) return today;
  // nearest future day, else most recent past day
  const future = days.filter((d) => d >= today).sort();
  if (future.length) return future[0];
  return days.slice().sort().reverse()[0];
}

export default function Home() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const isDesktop = Platform.OS === "web" && width >= 900;
  const numCols = isDesktop ? (width >= 1400 ? 3 : 2) : 1;

  const [matches, setMatches] = useState<Match[]>([]);
  const [days, setDays] = useState<string[]>([]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedLeague, setSelectedLeague] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dayPickerOpen, setDayPickerOpen] = useState(false);
  const [leaguePickerOpen, setLeaguePickerOpen] = useState(false);
  const [didInitDay, setDidInitDay] = useState(false);
  const [tierFilter, setTierFilter] = useState<"top" | "sec" | null>(null);

  const load = useCallback(async (day: string | null) => {
    try {
      const [ms, ds] = await Promise.all([
        api.matches(day || undefined),
        api.days(),
      ]);
      setMatches(ms);
      setDays(ds);
      return ds;
    } catch (e: any) {
      console.warn("load err", e?.message);
      return [];
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // On first load, default selectedDay to today (or nearest available)
  useEffect(() => {
    if (didInitDay) return;
    (async () => {
      setLoading(true);
      const ds = await load(null);
      const d = nearestDay(ds);
      if (d) setSelectedDay(d);
      setDidInitDay(true);
    })();
  }, [didInitDay, load]);

  useFocusEffect(useCallback(() => {
    if (!didInitDay) return;
    setLoading(true);
    load(selectedDay);
  }, [selectedDay, load, didInitDay]));

  // When changing day, reset league filter (because available leagues change)
  useEffect(() => { setSelectedLeague(null); }, [selectedDay]);

  // Available leagues for the current day scope
  const availableLeagues = useMemo(() => {
    const set = new Set<string>();
    matches.forEach((m) => set.add(m.manifestazione));
    return Array.from(set).sort();
  }, [matches]);

  // Client-side filtered list
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return matches.filter((m) => {
      if (selectedLeague && m.manifestazione !== selectedLeague) return false;
      if (tierFilter) {
        const code = m.manifestazione.trim().toUpperCase();
        const matchTop = /1\b|1$/.test(code) || /^[A-Z]+1/.test(code);
        const matchSec = /2\b|2$/.test(code) || /^[A-Z]+2/.test(code);
        if (tierFilter === "top" && !matchTop) return false;
        if (tierFilter === "sec" && !matchSec) return false;
      }
      if (q) {
        const hay = `${m.squadra1} ${m.squadra2} ${m.manifestazione}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [matches, selectedLeague, query, tierFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, Match[]>();
    for (const m of filtered) {
      if (!map.has(m.manifestazione)) map.set(m.manifestazione, []);
      map.get(m.manifestazione)!.push(m);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const selectedCount = matches.filter((m) => m.selected).length;

  const toggleSelect = async (m: Match) => {
    const next = !m.selected;
    setMatches((arr) => arr.map((x) => x.id === m.id ? { ...x, selected: next } : x));
    try { await api.updateSelection([m.id], next); } catch {}
  };

  const clearAllSelection = () => {
    confirmAction({
      title: "Svuotare selezione?",
      message: "Tutte le partite selezionate verranno deselezionate.",
      confirmText: "Svuota",
      destructive: true,
      onConfirm: async () => {
        // Optimistic update
        setMatches((arr) => arr.map((x) => ({ ...x, selected: false })));
        try { await api.clearSelection(); } catch (e) { console.warn(e); }
        await load(selectedDay);
      },
    });
  };

  const goToToday = () => {
    const d = nearestDay(days);
    setSelectedDay(d);
    setSelectedLeague(null);
    setQuery("");
    setTierFilter(null);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Ionicons name="trophy" size={22} color={colors.primary} />
          <Text style={styles.title} testID="app-title">ScoreBlast</Text>
          {isDesktop && <Text style={styles.titleHint}>Desktop View</Text>}
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TouchableOpacity
            testID="btn-reset"
            onPress={goToToday}
            style={styles.todayBtn}
          >
            <Ionicons name="refresh" size={14} color={colors.primary} />
            <Text style={styles.todayBtnTxt}>RESET</Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="open-strumenti"
            onPress={() => router.push("/strumenti")}
            style={styles.menuBtn}
          >
            <Text style={styles.menuBtnTxt}>Strumenti</Text>
            <Ionicons name="chevron-down" size={14} color={colors.text} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={isDesktop ? styles.desktopWrap : { flex: 1 }}>

      {/* Filter bar - ordered: 1) Day, 2) Championship, 3) Search */}
      <View style={styles.filtersWrap}>
        <View style={styles.filterRow}>
          <Text style={styles.filterStep}>1</Text>
          <TouchableOpacity
            testID="filter-day"
            onPress={() => setDayPickerOpen(true)}
            style={styles.filterField}
          >
            <Ionicons name="calendar-outline" size={14} color={colors.primary} />
            <Text style={styles.filterFieldTxt} numberOfLines={1}>
              {selectedDay ? fmtDay(selectedDay) : "TUTTI I GIORNI"}
            </Text>
            <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
          </TouchableOpacity>
          {selectedDay && (
            <TouchableOpacity
              testID="reset-day"
              onPress={() => setSelectedDay(null)}
              style={styles.resetBtn}
            >
              <Ionicons name="close" size={14} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.filterRow}>
          <Text style={styles.filterStep}>2</Text>
          <TouchableOpacity
            testID="filter-league"
            onPress={() => setLeaguePickerOpen(true)}
            style={styles.filterField}
            disabled={availableLeagues.length === 0}
          >
            <Ionicons name="football-outline" size={14} color={colors.primary} />
            <Text style={styles.filterFieldTxt} numberOfLines={1}>
              {selectedLeague || "TUTTI I CAMPIONATI"}
            </Text>
            <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
          </TouchableOpacity>
          {selectedLeague && (
            <TouchableOpacity
              testID="reset-league"
              onPress={() => setSelectedLeague(null)}
              style={styles.resetBtn}
            >
              <Ionicons name="close" size={14} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.filterRow}>
          <Text style={styles.filterStep}>3</Text>
          <View style={styles.filterField}>
            <Ionicons name="search" size={14} color={colors.primary} />
            <TextInput
              testID="search-input"
              placeholder="Cerca partita per nome squadra"
              placeholderTextColor={colors.textDim}
              value={query}
              onChangeText={setQuery}
              style={styles.searchInput}
            />
            {query.length > 0 && (
              <TouchableOpacity testID="reset-query" onPress={() => setQuery("")} hitSlop={10}>
                <Ionicons name="close" size={14} color={colors.textMuted} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Quick filters: campionati TOP / SECONDARI */}
        <View style={styles.tierRow}>
          <TouchableOpacity
            testID="tier-top"
            onPress={() => setTierFilter(tierFilter === "top" ? null : "top")}
            style={[styles.tierBtn, tierFilter === "top" && styles.tierBtnActive]}
          >
            <Ionicons name="star" size={12} color={tierFilter === "top" ? "#FFF" : colors.primary} />
            <Text style={[styles.tierBtnTxt, tierFilter === "top" && { color: "#FFF" }]}>
              CAMPIONATI TOP (1)
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            testID="tier-sec"
            onPress={() => setTierFilter(tierFilter === "sec" ? null : "sec")}
            style={[styles.tierBtn, tierFilter === "sec" && styles.tierBtnActive]}
          >
            <Ionicons name="star-half" size={12} color={tierFilter === "sec" ? "#FFF" : colors.primary} />
            <Text style={[styles.tierBtnTxt, tierFilter === "sec" && { color: "#FFF" }]}>
              SECONDARI (2)
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Counter */}
      <View style={styles.countRow}>
        <Text style={styles.countTxt}>
          <Text style={styles.countNum}>{filtered.length}</Text> partite
          <Text style={styles.countSep}>  /  </Text>
          <Text style={styles.countNum}>{matches.length}</Text> totali
        </Text>
        {selectedCount > 0 && (
          <View style={styles.selRow}>
            <Text style={styles.selCount}>{selectedCount} selezionate</Text>
            <TouchableOpacity
              testID="clear-selection"
              onPress={clearAllSelection}
              style={styles.clearBtn}
            >
              <Ionicons name="trash-outline" size={12} color={colors.danger} />
              <Text style={styles.clearBtnTxt}>Svuota</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {loading ? (
        <View style={styles.loader}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : matches.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="document-text-outline" size={56} color={colors.textDim} />
          <Text style={styles.emptyTxt}>Nessuna partita caricata</Text>
          <TouchableOpacity
            testID="empty-go-tools"
            onPress={() => router.push("/strumenti")}
            style={styles.emptyBtn}
          >
            <Text style={styles.emptyBtnTxt}>Carica Excel</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(selectedDay, query); }}
              tintColor={colors.primary}
            />
          }
        >
          {grouped.map(([league, items]) => (
            <View key={league} style={styles.leagueBlock}>
              <View style={styles.leagueHeader}>
                <Ionicons name="football-outline" size={14} color={colors.primary} />
                <Text style={styles.leagueTxt}>{league}</Text>
                <Text style={styles.leagueCount}>{items.length}</Text>
              </View>
              <View style={isDesktop ? styles.cardsGrid : undefined}>
              {items.map((m) => {
                const sign = bestSign(m);
                return (
                  <TouchableOpacity
                    key={m.id}
                    testID={`match-${m.id}`}
                    onPress={() => router.push(`/match/${m.id}`)}
                    onLongPress={() => toggleSelect(m)}
                    activeOpacity={0.8}
                    style={[
                      styles.card,
                      m.selected && styles.cardSelected,
                      isDesktop && { width: `${100 / numCols - 1}%` },
                    ]}
                  >
                    <TouchableOpacity
                      testID={`select-${m.id}`}
                      onPress={() => toggleSelect(m)}
                      style={[styles.checkbox, m.selected && styles.checkboxOn]}
                      hitSlop={10}
                    >
                      {m.selected && <Ionicons name="checkmark" size={14} color="#FFF" />}
                    </TouchableOpacity>

                    <View style={styles.teamsCol}>
                      <Text style={styles.teamTxt} numberOfLines={1}>{m.squadra1}</Text>
                      <Text style={styles.teamTxt} numberOfLines={1}>{m.squadra2}</Text>
                      {m.result && (
                        <Text style={styles.resultTxt}>{m.result}</Text>
                      )}
                    </View>

                    <View style={styles.timeCol}>
                      <Text style={styles.timeLbl}>{fmtDay(m.day)}</Text>
                      <Text style={styles.timeTxt}>{m.time}</Text>
                    </View>

                    <View style={styles.oddCol}>
                      <LinearGradient
                        colors={[colors.primaryLight, colors.primaryDark]}
                        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                        style={styles.signBadge}
                      >
                        <Text style={styles.signTopLbl}>{sign.label}</Text>
                        <Text style={styles.signValue}>{sign.value?.toFixed(2) ?? "—"}</Text>
                      </LinearGradient>
                      <View style={styles.smallBadges}>
                        {m.main_prediction && (
                          <View style={styles.aiBadge}>
                            <Ionicons name="sparkles" size={10} color={colors.aiText} />
                            <Text style={styles.aiBadgeTxt}>{m.main_prediction}</Text>
                          </View>
                        )}
                        {m.family && (
                          <View style={styles.clusterBadge}>
                            <Text style={styles.clusterBadgeTxt} numberOfLines={1}>
                              {m.family.split("_")[0]}
                            </Text>
                          </View>
                        )}
                      </View>
                    </View>
                  </TouchableOpacity>
                );
              })}
              </View>
            </View>
          ))}
          <View style={{ height: 100 }} />
        </ScrollView>
      )}
      </View>

      {/* FAB */}
      {selectedCount > 0 && (
        <TouchableOpacity
          testID="fab-selected"
          onPress={() => router.push("/selected")}
          style={styles.fab}
          activeOpacity={0.85}
        >
          <LinearGradient
            colors={[colors.primaryLight, colors.primaryDark]}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={styles.fabInner}
          >
            <Ionicons name="albums" size={18} color="#FFF" />
            <Text style={styles.fabTxt}>{selectedCount} selezionate</Text>
            <Ionicons name="arrow-forward" size={16} color="#FFF" />
          </LinearGradient>
        </TouchableOpacity>
      )}

      <BottomNav />

      {/* Day picker modal */}
      <Modal visible={dayPickerOpen} transparent animationType="fade" onRequestClose={() => setDayPickerOpen(false)}>
        <TouchableOpacity style={styles.modalBg} activeOpacity={1} onPress={() => setDayPickerOpen(false)}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Seleziona Giorno</Text>
            <FlatList
              data={[null, ...days]}
              keyExtractor={(it, i) => it ?? `all-${i}`}
              renderItem={({ item }) => (
                <TouchableOpacity
                  testID={`day-${item ?? "all"}`}
                  onPress={() => { setSelectedDay(item); setDayPickerOpen(false); }}
                  style={[styles.dayItem, item === selectedDay && styles.dayItemActive]}
                >
                  <Text style={[styles.dayItemTxt, item === selectedDay && { color: "#FFF" }]}>
                    {item ? fmtDay(item) : "TUTTI I GIORNI"}
                  </Text>
                </TouchableOpacity>
              )}
            />
          </View>
        </TouchableOpacity>
      </Modal>

      {/* League picker modal */}
      <Modal visible={leaguePickerOpen} transparent animationType="fade" onRequestClose={() => setLeaguePickerOpen(false)}>
        <TouchableOpacity style={styles.modalBg} activeOpacity={1} onPress={() => setLeaguePickerOpen(false)}>
          <View style={styles.modalBox}>
            <Text style={styles.modalTitle}>Seleziona Campionato</Text>
            <FlatList
              data={[null, ...availableLeagues]}
              keyExtractor={(it, i) => it ?? `all-${i}`}
              renderItem={({ item }) => (
                <TouchableOpacity
                  testID={`league-${item ?? "all"}`}
                  onPress={() => { setSelectedLeague(item); setLeaguePickerOpen(false); }}
                  style={[styles.dayItem, item === selectedLeague && styles.dayItemActive]}
                >
                  <Text style={[styles.dayItemTxt, item === selectedLeague && { color: "#FFF" }]}>
                    {item || "TUTTI I CAMPIONATI"}
                  </Text>
                </TouchableOpacity>
              )}
            />
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: colors.text, fontSize: 22, fontWeight: "900", letterSpacing: -0.5 },
  titleHint: { color: colors.textDim, fontSize: 10, fontWeight: "700", letterSpacing: 1, marginLeft: 8 },
  todayBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(255,87,34,0.12)", borderWidth: 1, borderColor: colors.primary,
    paddingHorizontal: 10, paddingVertical: 8, borderRadius: 999,
  },
  todayBtnTxt: { color: colors.primary, fontSize: 11, fontWeight: "900", letterSpacing: 0.5 },
  resetTopBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 10, paddingVertical: 8, borderRadius: 999,
  },
  resetTopTxt: { color: colors.textMuted, fontSize: 11, fontWeight: "900", letterSpacing: 0.5 },
  menuBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999,
  },
  menuBtnTxt: { color: colors.text, fontSize: 12, fontWeight: "700" },
  filtersWrap: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4, gap: 8 },
  filterRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  filterStep: {
    color: colors.primary, fontSize: 11, fontWeight: "900",
    width: 18, height: 18, lineHeight: 18, textAlign: "center",
    backgroundColor: "rgba(255,87,34,0.15)", borderRadius: 999,
  },
  filterField: {
    flex: 1, flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10,
  },
  filterFieldTxt: { flex: 1, color: colors.text, fontSize: 12, fontWeight: "700", letterSpacing: 0.3 },
  resetBtn: {
    width: 36, height: 36, borderRadius: 10, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center",
  },
  searchInput: { color: colors.text, fontSize: 13, flex: 1, paddingVertical: 0 },
  tierRow: { flexDirection: "row", gap: 8, marginTop: 4, paddingLeft: 26 },
  tierBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.primary,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
  },
  tierBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  tierBtnTxt: { color: colors.primary, fontSize: 10, fontWeight: "900", letterSpacing: 0.5 },
  countRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 16, paddingBottom: 8,
  },
  countTxt: { color: colors.textMuted, fontSize: 12, fontWeight: "500" },
  countNum: { color: colors.text, fontWeight: "800" },
  countSep: { color: colors.textDim },
  selRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  selCount: { color: colors.primary, fontSize: 12, fontWeight: "700" },
  clearBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(239,68,68,0.10)", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999,
    borderWidth: 1, borderColor: "rgba(239,68,68,0.3)",
  },
  clearBtnTxt: { color: colors.danger, fontSize: 10, fontWeight: "800", letterSpacing: 0.5 },
  desktopWrap: { flex: 1, maxWidth: 1400, width: "100%", alignSelf: "center" },
  desktopSidebar: {},
  listDesktop: { paddingHorizontal: 24, gap: 12 },
  cardsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  loader: { flex: 1, justifyContent: "center", alignItems: "center" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  emptyTxt: { color: colors.textMuted, fontSize: 15 },
  emptyBtn: { backgroundColor: colors.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 999 },
  emptyBtnTxt: { color: "#FFF", fontWeight: "800" },
  list: { padding: 16, gap: 8 },
  leagueBlock: { marginBottom: 12 },
  leagueHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8, marginTop: 4 },
  leagueTxt: { color: colors.primary, fontSize: 13, fontWeight: "900", letterSpacing: 1, textTransform: "uppercase", flex: 1 },
  leagueCount: { color: colors.textMuted, fontSize: 12, fontWeight: "700" },
  card: {
    flexDirection: "row", alignItems: "center", gap: 10,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: 14, padding: 12, marginBottom: 8,
  },
  cardSelected: { borderColor: colors.primary, backgroundColor: "rgba(255,87,34,0.06)" },
  checkbox: {
    width: 22, height: 22, borderRadius: 6,
    borderWidth: 2, borderColor: colors.borderLight,
    alignItems: "center", justifyContent: "center",
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  teamsCol: { flex: 1, gap: 2 },
  teamTxt: { color: colors.text, fontSize: 13, fontWeight: "800", textTransform: "uppercase" },
  resultTxt: { color: colors.success, fontSize: 12, fontWeight: "700", marginTop: 2 },
  timeCol: { alignItems: "center", paddingHorizontal: 8 },
  timeLbl: { color: colors.textDim, fontSize: 9, fontWeight: "700", letterSpacing: 0.5 },
  timeTxt: { color: colors.text, fontSize: 16, fontWeight: "900", marginTop: 2 },
  oddCol: { alignItems: "flex-end", gap: 4 },
  signBadge: {
    minWidth: 78, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 10,
    alignItems: "center", justifyContent: "center",
  },
  signTopLbl: { color: "#FFF", fontSize: 9, fontWeight: "800", opacity: 0.9, letterSpacing: 0.5, textAlign: "center" },
  signValue: { color: "#FFF", fontSize: 15, fontWeight: "900", textAlign: "center" },
  smallBadges: { flexDirection: "row", gap: 4, marginTop: 2 },
  aiBadge: {
    flexDirection: "row", alignItems: "center", gap: 3,
    backgroundColor: colors.aiBg, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
  },
  aiBadgeTxt: { color: colors.aiText, fontSize: 9, fontWeight: "800" },
  clusterBadge: { backgroundColor: colors.clusterBg, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, maxWidth: 80 },
  clusterBadgeTxt: { color: colors.clusterText, fontSize: 9, fontWeight: "800" },
  fab: { position: "absolute", right: 16, bottom: 88, borderRadius: 999, overflow: "hidden", elevation: 8 },
  fabInner: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  fabTxt: { color: "#FFF", fontWeight: "800", fontSize: 13 },
  modalBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "center", alignItems: "center", padding: 24 },
  modalBox: { backgroundColor: colors.surface, borderRadius: 14, padding: 16, width: "100%", maxHeight: "70%", borderWidth: 1, borderColor: colors.border },
  modalTitle: { color: colors.text, fontSize: 16, fontWeight: "900", marginBottom: 12 },
  dayItem: { paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10, marginBottom: 4, backgroundColor: colors.surfaceHi },
  dayItemActive: { backgroundColor: colors.primary },
  dayItemTxt: { color: colors.text, fontSize: 13, fontWeight: "700", letterSpacing: 0.5 },
});

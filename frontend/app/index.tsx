import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, RefreshControl, Modal, FlatList, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";

import { api, Match } from "@/src/api";
import { colors } from "@/src/theme";
import BottomNav from "@/src/components/BottomNav";
import { OddBadge } from "@/src/components/OddBadge";

function bestSign(m: Match): { label: string; value?: number } {
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

export default function Home() {
  const router = useRouter();
  const [matches, setMatches] = useState<Match[]>([]);
  const [days, setDays] = useState<string[]>([]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dayPickerOpen, setDayPickerOpen] = useState(false);

  const load = useCallback(async (day: string | null, q: string) => {
    try {
      const [ms, ds] = await Promise.all([
        api.matches(day || undefined, q || undefined),
        api.days(),
      ]);
      setMatches(ms);
      setDays(ds);
      if (!day && ds.length && selectedDay == null) setSelectedDay(ds[0]);
    } catch (e: any) {
      console.warn("load err", e?.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedDay]);

  useFocusEffect(useCallback(() => {
    setLoading(true);
    load(selectedDay, query);
  }, [selectedDay, query, load]));

  const grouped = useMemo(() => {
    const map = new Map<string, Match[]>();
    for (const m of matches) {
      if (!map.has(m.manifestazione)) map.set(m.manifestazione, []);
      map.get(m.manifestazione)!.push(m);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [matches]);

  const selectedCount = matches.filter((m) => m.selected).length;

  const toggleSelect = async (m: Match) => {
    const next = !m.selected;
    setMatches((arr) => arr.map((x) => x.id === m.id ? { ...x, selected: next } : x));
    try { await api.updateSelection([m.id], next); } catch {}
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Ionicons name="trophy" size={22} color={colors.primary} />
          <Text style={styles.title} testID="app-title">ScoreBlast</Text>
        </View>
        <TouchableOpacity
          testID="open-strumenti"
          onPress={() => router.push("/strumenti")}
          style={styles.menuBtn}
        >
          <Text style={styles.menuBtnTxt}>Strumenti</Text>
          <Ionicons name="chevron-down" size={14} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* Filter bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filtersBar}
      >
        <TouchableOpacity
          testID="filter-day"
          onPress={() => setDayPickerOpen(true)}
          style={styles.pill}
        >
          <Ionicons name="calendar-outline" size={14} color={colors.primary} />
          <Text style={styles.pillTxt}>{selectedDay ? fmtDay(selectedDay) : "TUTTI"}</Text>
        </TouchableOpacity>

        <View style={styles.searchPill}>
          <Ionicons name="search" size={14} color={colors.textMuted} />
          <TextInput
            testID="search-input"
            placeholder="Cerca squadra"
            placeholderTextColor={colors.textDim}
            value={query}
            onChangeText={setQuery}
            style={styles.searchInput}
          />
        </View>

        {selectedDay && (
          <TouchableOpacity
            testID="filter-all-days"
            onPress={() => setSelectedDay(null)}
            style={[styles.pill, styles.pillActive]}
          >
            <Text style={[styles.pillTxt, { color: "#FFF" }]}>TUTTI I GIORNI</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* Counter */}
      <View style={styles.countRow}>
        <Text style={styles.countTxt}>
          <Text style={styles.countNum}>{matches.length}</Text> partite
          <Text style={styles.countSep}>  /  </Text>
          <Text style={styles.countNum}>{matches.length}</Text> totali
        </Text>
        {selectedCount > 0 && (
          <Text style={styles.selCount}>{selectedCount} selezionate</Text>
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
              {items.map((m) => {
                const sign = bestSign(m);
                return (
                  <TouchableOpacity
                    key={m.id}
                    testID={`match-${m.id}`}
                    onPress={() => router.push(`/match/${m.id}`)}
                    onLongPress={() => toggleSelect(m)}
                    activeOpacity={0.8}
                    style={[styles.card, m.selected && styles.cardSelected]}
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
          ))}
          <View style={{ height: 100 }} />
        </ScrollView>
      )}

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
  menuBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999,
  },
  menuBtnTxt: { color: colors.text, fontSize: 12, fontWeight: "700" },
  filtersBar: { gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  pill: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999,
  },
  pillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  pillTxt: { color: colors.text, fontSize: 11, fontWeight: "800", letterSpacing: 0.5 },
  searchPill: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, minWidth: 160,
  },
  searchInput: { color: colors.text, fontSize: 13, flex: 1, paddingVertical: 4 },
  countRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: 16, paddingBottom: 8,
  },
  countTxt: { color: colors.textMuted, fontSize: 12, fontWeight: "500" },
  countNum: { color: colors.text, fontWeight: "800" },
  countSep: { color: colors.textDim },
  selCount: { color: colors.primary, fontSize: 12, fontWeight: "700" },
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
    minWidth: 64, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10,
    alignItems: "center", justifyContent: "center",
  },
  signTopLbl: { color: "#FFF", fontSize: 9, fontWeight: "800", opacity: 0.9, letterSpacing: 0.5 },
  signValue: { color: "#FFF", fontSize: 17, fontWeight: "900" },
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

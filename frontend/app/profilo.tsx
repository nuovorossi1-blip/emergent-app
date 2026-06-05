import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from "react-native";
import { useBottomNav } from "@/src/components/BottomNavContext";
import { marketStatsCache } from "@/src/utils/cache";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import BottomNav from "@/src/components/BottomNav";
import { colors } from "@/src/theme";
import { api } from "@/src/api";

type Stat = { family: string; market: string; wins: number; losses: number; total: number; missed: number; family_total: number; miss_rate: number; win_rate: number };

export default function Profilo() {
  const bottomNav = useBottomNav();
  const router = useRouter();
  const [stats, setStats] = useState<Stat[] | null>(null);
  const [familyTotals, setFamilyTotals] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  useFocusEffect(useCallback(() => {
    // Stale-while-revalidate: mostro subito dalla cache, refresh in background
    const cached = marketStatsCache.get();
    if (cached) {
      setStats(cached);
      setLoading(false);
    }
    if (cached && !marketStatsCache.isStale()) return;
    if (!cached) setLoading(true);
    (async () => {
      try {
        const s = await api.marketStats();
        marketStatsCache.set(s.markets || []);
        setStats(s.markets || []);
        setFamilyTotals(s.family_totals || {});
      } catch { if (!cached) { setStats([]); setFamilyTotals({}); } }
      finally { setLoading(false); }
    })();
  }, []));

  const totalEval = (stats || []).reduce((s, x) => s + x.total, 0);
  const totalWins = (stats || []).reduce((s, x) => s + x.wins, 0);
  const totalMissed = (stats || []).reduce((s, x) => s + x.missed, 0);
  const globalWR = totalEval > 0 ? Math.round((totalWins / totalEval) * 100) : 0;
  // Candidates: 0 W/L + ≥5 missed + miss_rate ≥ 50% (significant)
  const candidates = (stats || []).filter((s) => s.total === 0 && s.missed >= 5 && s.miss_rate >= 50);
  const topMarkets = (stats || []).filter((s) => s.total >= 5).sort((a, b) => b.win_rate - a.win_rate).slice(0, 5);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Profilo</Text>
        <Text style={styles.subtitle}>Statistiche & Machine Learning</Text>
      </View>

      <ScrollView contentContainerStyle={styles.list} onScroll={(e) => bottomNav.handleScroll(e.nativeEvent.contentOffset.y)} scrollEventThrottle={16}>
        {loading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
        ) : (
          <>
            {/* KPI Row */}
            <View style={styles.kpiRow}>
              <View style={styles.kpiBox}>
                <Text style={styles.kpiNum}>{totalEval}</Text>
                <Text style={styles.kpiLbl}>VALUTAZIONI</Text>
              </View>
              <View style={styles.kpiBox}>
                <Text style={[styles.kpiNum, { color: globalWR >= 60 ? "#10B981" : globalWR >= 45 ? colors.primary : "#EF4444" }]}>{globalWR}%</Text>
                <Text style={styles.kpiLbl}>WIN RATE</Text>
              </View>
              <View style={[styles.kpiBox, totalMissed > 0 && { borderColor: "rgba(245,158,11,0.6)" }]}>
                <Text style={[styles.kpiNum, { color: "#F59E0B" }]}>{totalMissed}</Text>
                <Text style={styles.kpiLbl}>OPP. PERSE</Text>
              </View>
            </View>

            {/* Statistiche ML link */}
            <TouchableOpacity testID="open-ml" onPress={() => router.push("/stats")} style={styles.linkCard}>
              <Ionicons name="bulb" size={22} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.linkTitle}>Statistiche ML dettagliate</Text>
                <Text style={styles.linkDesc}>Vedi win-rate per famiglia, mercato e opportunità perse</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </TouchableOpacity>

            {/* LLM & Budget link */}
            <TouchableOpacity testID="open-llm" onPress={() => router.push("/llm-settings")} style={styles.linkCard}>
              <Ionicons name="sparkles" size={22} color={colors.aiText} />
              <View style={{ flex: 1 }}>
                <Text style={styles.linkTitle}>LLM & Budget</Text>
                <Text style={styles.linkDesc}>Modello AI, costi stimati, gestione</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </TouchableOpacity>

            {/* Top markets */}
            {topMarkets.length > 0 && (
              <View style={styles.block}>
                <Text style={styles.blockTitle}>TOP MERCATI (≥ 5 valutazioni)</Text>
                {topMarkets.map((s, i) => (
                  <View key={i} style={styles.row}>
                    <Text style={styles.rank}>#{i + 1}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.market}>{s.market}</Text>
                      <Text style={styles.detail}>{s.family} · {s.wins}W/{s.losses}L su {s.total}</Text>
                    </View>
                    <View style={[styles.wrTag, s.win_rate >= 60 ? styles.wrGood : s.win_rate < 40 ? styles.wrBad : styles.wrNeutral]}>
                      <Text style={styles.wrTxt}>{s.win_rate}%</Text>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {/* Candidati */}
            {candidates.length > 0 && (
              <View style={styles.block}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <Ionicons name="bulb" size={14} color="#F59E0B" />
                  <Text style={[styles.blockTitle, { color: "#F59E0B" }]}>MERCATI CANDIDATI (gialli)</Text>
                </View>
                <Text style={styles.candHint}>Mercati che avrebbero vinto spesso ma non sono mai stati scelti. Considera di iniziare a giocarli.</Text>
                {candidates.slice(0, 8).map((s, i) => (
                  <View key={i} style={[styles.row, styles.candRow]}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.market}>{s.market}</Text>
                      <Text style={styles.detail}>{s.family} · {s.missed}/{s.family_total} partite ({s.miss_rate}%)</Text>
                    </View>
                    <Text style={styles.candVal}>{s.miss_rate.toFixed(0)}%</Text>
                  </View>
                ))}
              </View>
            )}

            {!loading && totalEval === 0 && totalMissed === 0 && (
              <View style={styles.empty}>
                <Ionicons name="bulb-outline" size={56} color={colors.textDim} />
                <Text style={styles.emptyTxt}>Inizia ad inserire risultati</Text>
                <Text style={styles.emptyHint}>Le statistiche ML appariranno qui appena inserirai i primi risultati nelle partite della Schedina.</Text>
              </View>
            )}

            <View style={{ height: 100 }} />
          </>
        )}
      </ScrollView>

      <BottomNav />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { color: colors.text, fontSize: 26, fontWeight: "900", letterSpacing: -0.5 },
  subtitle: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  list: { padding: 16, paddingBottom: 28, gap: 14 },
  kpiRow: { flexDirection: "row", gap: 10 },
  kpiBox: { flex: 1, alignItems: "center", paddingVertical: 14, backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border },
  kpiNum: { color: colors.primary, fontSize: 28, fontWeight: "900" },
  kpiLbl: { color: colors.textMuted, fontSize: 9, fontWeight: "800", letterSpacing: 1, marginTop: 4 },
  linkCard: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  linkTitle: { color: colors.text, fontSize: 14, fontWeight: "800" },
  linkDesc: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  block: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 12, gap: 8 },
  blockTitle: { color: colors.primary, fontSize: 10, fontWeight: "900", letterSpacing: 1, marginBottom: 4 },
  candHint: { color: colors.textMuted, fontSize: 11, lineHeight: 16, marginBottom: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, padding: 10, backgroundColor: colors.surfaceHi, borderRadius: 8 },
  candRow: { backgroundColor: "rgba(245,158,11,0.10)", borderWidth: 1, borderColor: "rgba(245,158,11,0.30)" },
  rank: { color: colors.primary, fontSize: 14, fontWeight: "900", width: 28 },
  market: { color: colors.text, fontSize: 13, fontWeight: "800" },
  detail: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  candVal: { color: "#F59E0B", fontSize: 11, fontWeight: "900" },
  wrTag: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, minWidth: 52, alignItems: "center" },
  wrGood: { backgroundColor: "rgba(16,185,129,0.20)" },
  wrBad: { backgroundColor: "rgba(239,68,68,0.20)" },
  wrNeutral: { backgroundColor: colors.surfaceHi },
  wrTxt: { color: colors.text, fontSize: 12, fontWeight: "900" },
  empty: { alignItems: "center", padding: 32, gap: 8 },
  emptyTxt: { color: colors.text, fontSize: 15, fontWeight: "700" },
  emptyHint: { color: colors.textMuted, fontSize: 12, textAlign: "center", lineHeight: 18 },
});

import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";

import { api, Match, Prediction, MARKET_FAMILIES, ODD_LABELS, OddsKey, quickPredictionFamily, rankPicks } from "@/src/api";
import { colors } from "@/src/theme";
import { ScoreInput } from "@/src/components/ScoreInput";
import { predictionQueue } from "@/src/utils/predictionQueue";

export default function MatchDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [match, setMatch] = useState<Match | null>(null);
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [loading, setLoading] = useState(true);
  const [aiPending, setAiPending] = useState(false);
  const [result, setResult] = useState("");
  const [marketStats, setMarketStats] = useState<{ market: string; win_rate: number; total: number; family: string }[]>([]);

  const load = useCallback(async () => {
    try {
      const [m, stats] = await Promise.all([api.match(id!), api.marketStats().catch(() => [])]);
      setMatch(m);
      setPrediction(m.prediction ?? null);
      setResult(m.result || "");
      setMarketStats(stats || []);
    } catch (e: any) {
      Alert.alert("Errore", e?.message || "Caricamento");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Subscribe to background prediction queue so the UI reflects in-flight requests
  useEffect(() => {
    if (!id) return;
    const updateState = async () => {
      const wasPending = predictionQueue.isPending(id);
      setAiPending(wasPending);
      // If a background prediction just finished, refresh the data
      if (!wasPending && match && !match.prediction && prediction === null) {
        try { const m = await api.match(id); setMatch(m); setPrediction(m.prediction ?? null); } catch {}
      }
    };
    updateState();
    const unsub = predictionQueue.subscribe(updateState);
    return unsub;
  }, [id]);

  // Polling fallback while a background prediction is in flight
  useEffect(() => {
    if (!aiPending || !id) return;
    const interval = setInterval(async () => {
      try {
        const m = await api.match(id);
        if (m.prediction) {
          setMatch(m);
          setPrediction(m.prediction);
          clearInterval(interval);
        }
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [aiPending, id]);

  const runPrediction = (forceRegen: boolean = false) => {
    if (!id) return;
    // FIRE-AND-FORGET: la richiesta viene avviata e tracciata dalla queue globale.
    // L'utente può tornare alla home; quando la risposta arriva, lo stato si aggiorna.
    setAiPending(true);
    predictionQueue.enqueue(id, forceRegen).then((p) => {
      if (p) {
        setPrediction(p);
        load();
      }
    });
  };

  const saveResult = async () => {
    if (!id || !result.trim()) return;
    try {
      const out = await api.setResult(id, result.trim());
      if (out.learning?.applied) {
        const ok = out.learning.result_ok;
        Alert.alert(
          ok ? "✓ Pronostico VINTO" : "✗ Pronostico PERSO",
          `Mercato: ${out.learning.main_prediction}\n\nIl sistema ha aggiornato i punteggi della famiglia di pronostico per migliorare le prossime previsioni.`,
        );
      } else {
        Alert.alert("Salvato", "Risultato salvato");
      }
      await load();
    } catch (e: any) {
      Alert.alert("Errore", e?.message);
    }
  };

  const toggleSelect = async () => {
    if (!match) return;
    const next = !match.selected;
    setMatch({ ...match, selected: next });
    try { await api.updateSelection([match.id], next); } catch {}
  };

  if (loading || !match) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator color={colors.primary} style={{ marginTop: 60 }} />
      </SafeAreaView>
    );
  }

  // sort markets in each family by probability (lowest odd first = most probable)
  const families = MARKET_FAMILIES.map((fam) => {
    const items = fam.keys.map((k) => ({
      key: k,
      label: ODD_LABELS[k],
      value: match.odds[k] as number | undefined,
      estimated: (match.odds.estimated || []).includes(k),
    })).filter((x) => x.value != null);
    items.sort((a, b) => (a.value! - b.value!));
    return { name: fam.name, items };
  });

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity testID="back-btn" onPress={() => router.canGoBack() ? router.back() : router.replace("/")} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>{match.manifestazione}</Text>
        <TouchableOpacity testID="toggle-sel" onPress={toggleSelect} style={styles.iconBtn}>
          <Ionicons name={match.selected ? "checkmark-circle" : "ellipse-outline"} size={22}
            color={match.selected ? colors.primary : colors.textMuted} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Match hero */}
        <View style={styles.hero}>
          <Text style={styles.heroDay}>{match.day} · {match.time}</Text>
          <Text style={styles.team}>{match.squadra1}</Text>
          <Text style={styles.vs}>vs</Text>
          <Text style={styles.team}>{match.squadra2}</Text>
          {match.result && (
            <View style={styles.resultBox}>
              <Text style={styles.resultLbl}>RISULTATO</Text>
              <Text style={styles.resultVal}>{match.result}</Text>
            </View>
          )}
        </View>

        {/* Pre-pronostic family — local heuristic */}
        {(() => {
          const fam = quickPredictionFamily(match.odds);
          if (fam.length === 0) return null;
          const llmMarkets = match.playable_markets?.map((p) => p.market) || (match.main_prediction ? [match.main_prediction] : []);
          const ranked = rankPicks(fam, llmMarkets, marketStats);
          return (
            <View style={styles.preBlock}>
              <View style={styles.preHeader}>
                <Ionicons name="flash" size={14} color={colors.primary} />
                <Text style={styles.preTitle}>FAMIGLIA PRE-PRONOSTICO (locale)</Text>
              </View>
              <Text style={styles.preHint}>Mercati validi dalle quote, ordinati per affidabilità (concordanza AI + win-rate storico). Solo quote ≥ 1.40 e nessun segno 1/2/X se la quota corrispondente è &gt; 1.85.</Text>
              {ranked.map((p, i) => (
                <View key={i} style={[styles.preItem, p.source === "pre+ai" && styles.preItemConcord]}>
                  <View style={[styles.preRank, i === 0 && styles.preRankTop]}>
                    <Text style={[styles.preRankTxt, i === 0 && { color: "#FFF" }]}>{i + 1}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <Text style={styles.preMarket}>{p.market}</Text>
                      {p.odd > 0 && <Text style={styles.preOdd}>@ {p.odd.toFixed(2)}</Text>}
                      <Text style={styles.preFamily}>{p.family}</Text>
                      {p.source === "pre+ai" && (
                        <View style={styles.concordTag}>
                          <Ionicons name="checkmark-done" size={10} color="#10B981" />
                          <Text style={styles.concordTxt}>PRE+AI</Text>
                        </View>
                      )}
                      {p.source === "ai" && (
                        <View style={[styles.concordTag, { backgroundColor: colors.aiBg, borderColor: colors.aiText }]}>
                          <Ionicons name="sparkles" size={10} color={colors.aiText} />
                          <Text style={[styles.concordTxt, { color: colors.aiText }]}>SOLO AI</Text>
                        </View>
                      )}
                      {p.win_rate !== null && (
                        <View style={[styles.wrTag, p.win_rate >= 60 ? { backgroundColor: "rgba(16,185,129,0.18)" } : { backgroundColor: "rgba(239,68,68,0.18)" }]}>
                          <Text style={[styles.wrTxt, p.win_rate >= 60 ? { color: "#10B981" } : { color: "#EF4444" }]}>WR {p.win_rate.toFixed(0)}% ({p.total})</Text>
                        </View>
                      )}
                    </View>
                  </View>
                </View>
              ))}
            </View>
          );
        })()}

        {/* AI prediction block - always visible. Shows result_ok color when result is set */}
        <View style={[
          styles.aiBlock,
          match.result && prediction?.main_prediction && {
            borderColor: (() => {
              const parts = match.result.split("-").map(n => parseInt(n, 10));
              if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return colors.border;
              const home = parts[0], away = parts[1], total = home + away;
              const m = (prediction.main_prediction || "").toUpperCase().replace(/\s/g, "");
              let ok: boolean | null = null;
              if (m === "1") ok = home > away;
              else if (m === "X") ok = home === away;
              else if (m === "2") ok = away > home;
              else if (m.startsWith("1X")) ok = home >= away;
              else if (m.startsWith("X2")) ok = away >= home;
              else if (m.startsWith("12")) ok = home !== away;
              else if (m.startsWith("O")) { const n = parseFloat(m.replace(/[^\d.]/g, "")); ok = total > n; }
              else if (m.startsWith("U")) { const n = parseFloat(m.replace(/[^\d.]/g, "")); ok = total < n; }
              else if (m === "GG") ok = home > 0 && away > 0;
              else if (m === "NG") ok = home === 0 || away === 0;
              else if (m.includes("MG") && m.includes("2-4")) {
                if (m.includes("CASA")) ok = home >= 2 && home <= 4;
                else if (m.includes("OSPITE")) ok = away >= 2 && away <= 4;
                else ok = total >= 2 && total <= 4;
              }
              return ok === true ? colors.success : ok === false ? colors.danger : colors.border;
            })(),
            borderWidth: 2,
          },
        ]}>
          <View style={styles.aiHeader}>
            <Ionicons name="sparkles" size={16} color={colors.aiText} />
            <Text style={styles.aiTitle}>PRONOSTICO AI</Text>
            {prediction?.confidence && (
              <View style={styles.confBadge}>
                <Text style={styles.confTxt}>{prediction.confidence}</Text>
              </View>
            )}
          </View>
          {prediction ? (
            <>
              {prediction.family && (
                <View style={styles.familyTag}>
                  <Text style={styles.familyTxt}>{prediction.family}</Text>
                </View>
              )}
              {prediction.main_prediction && (
                <LinearGradient
                  colors={[colors.primaryLight, colors.primaryDark]}
                  start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                  style={styles.mainPred}
                >
                  <Text style={styles.mainPredLbl}>PRONOSTICO PRINCIPALE</Text>
                  <Text style={styles.mainPredVal}>{prediction.main_prediction}</Text>
                </LinearGradient>
              )}
              {prediction.analysis && (
                <Text style={styles.analysis}>{prediction.analysis}</Text>
              )}
              {prediction.playable_markets && prediction.playable_markets.length > 0 && (
                <View style={styles.playableList}>
                  <Text style={styles.playableTitle}>MERCATI GIOCABILI (ordine probabilità)</Text>
                  {prediction.playable_markets.map((p, i) => (
                    <View key={i} style={styles.playableItem}>
                      <View style={[styles.rankBadge, i === 0 && styles.rankBadgeTop]}>
                        <Text style={[styles.rankTxt, i === 0 && { color: "#FFF" }]}>{i + 1}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.playableMarket}>{p.market}</Text>
                        <Text style={styles.playableReason}>{p.reasoning}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              )}
              <TouchableOpacity
                testID="regen-ai"
                onPress={() => runPrediction(true)}
                disabled={aiPending}
                style={styles.regenBtn}
              >
                {aiPending ? (
                  <ActivityIndicator color={colors.primary} size="small" />
                ) : (
                  <>
                    <Ionicons name="refresh" size={14} color={colors.primary} />
                    <Text style={styles.regenBtnTxt}>Rigenera Pronostico</Text>
                  </>
                )}
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity
              testID="gen-ai"
              onPress={() => runPrediction(false)}
              disabled={aiPending}
              style={styles.aiBtn}
              activeOpacity={0.85}
            >
              <LinearGradient
                colors={[colors.primaryLight, colors.primaryDark]}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                style={styles.aiBtnInner}
              >
                {aiPending ? (
                  <>
                    <ActivityIndicator color="#FFF" />
                    <Text style={[styles.aiBtnTxt, { marginLeft: 8 }]}>Generazione in corso…</Text>
                  </>
                ) : (
                  <>
                    <Ionicons name="sparkles" size={16} color="#FFF" />
                    <Text style={styles.aiBtnTxt}>Genera Pronostico</Text>
                  </>
                )}
              </LinearGradient>
            </TouchableOpacity>
          )}
        </View>

        {/* Market families */}
        <Text style={styles.sectionTitle}>QUOTE PER FAMIGLIA DI MERCATO</Text>
        {families.map((fam) => fam.items.length > 0 && (
          <View key={fam.name} style={styles.famBlock}>
            <Text style={styles.famName}>{fam.name}</Text>
            <View style={styles.famGrid}>
              {fam.items.map((it, idx) => (
                <View key={it.key} style={[styles.famCard, idx === 0 && styles.famCardTop]}>
                  <Text style={[styles.famLbl, idx === 0 && { color: "#FFE4D9" }]}>{it.label}</Text>
                  <Text style={[styles.famVal, idx === 0 && { color: "#FFF" }]}>
                    {it.value!.toFixed(2)}
                  </Text>
                  {it.estimated && (
                    <Text style={[styles.famEst, idx === 0 && { color: "#FFE4D9" }]}>(stima)</Text>
                  )}
                  {idx === 0 && (
                    <View style={styles.topMark}>
                      <Ionicons name="star" size={9} color="#FFF" />
                    </View>
                  )}
                </View>
              ))}
            </View>
          </View>
        ))}

        {/* Result input */}
        <View style={styles.resultBlock}>
          <Text style={styles.sectionTitle}>RISULTATO {match.result ? "(MODIFICABILE)" : ""}</Text>
          <ScoreInput value={result} onChange={setResult} size="md" testIDPrefix="result" />
          <TouchableOpacity testID="save-result" onPress={saveResult} style={styles.saveResultBtn}>
            <Ionicons name="save" size={16} color="#FFF" />
            <Text style={styles.saveResultTxt}>Salva Risultato</Text>
          </TouchableOpacity>
        </View>
        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  iconBtn: { padding: 8 },
  headerTitle: { flex: 1, color: colors.text, fontSize: 14, fontWeight: "800", textAlign: "center", textTransform: "uppercase", letterSpacing: 0.5 },
  content: { padding: 16, gap: 16 },
  hero: { alignItems: "center", paddingVertical: 16, backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.border },
  heroDay: { color: colors.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 1, marginBottom: 12 },
  team: { color: colors.text, fontSize: 18, fontWeight: "900", textTransform: "uppercase" },
  vs: { color: colors.textDim, fontSize: 12, fontWeight: "700", marginVertical: 4 },
  resultBox: { marginTop: 12, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: colors.surfaceHi, borderRadius: 10, alignItems: "center" },
  resultLbl: { color: colors.textMuted, fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  resultVal: { color: colors.success, fontSize: 22, fontWeight: "900", marginTop: 2 },
  aiBlock: { backgroundColor: colors.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: colors.border, gap: 10 },
  aiHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  aiTitle: { color: colors.aiText, fontSize: 12, fontWeight: "900", letterSpacing: 1, flex: 1 },
  confBadge: { backgroundColor: colors.aiBg, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  confTxt: { color: colors.aiText, fontSize: 10, fontWeight: "800" },
  familyTag: { alignSelf: "flex-start", backgroundColor: colors.clusterBg, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  familyTxt: { color: colors.clusterText, fontSize: 11, fontWeight: "800", letterSpacing: 0.5 },
  mainPred: { padding: 12, borderRadius: 10, alignItems: "center" },
  mainPredLbl: { color: "#FFE4D9", fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  mainPredVal: { color: "#FFF", fontSize: 24, fontWeight: "900", marginTop: 4 },
  analysis: { color: colors.text, fontSize: 13, lineHeight: 20 },
  playableList: { gap: 8, marginTop: 4 },
  playableTitle: { color: colors.textMuted, fontSize: 10, fontWeight: "800", letterSpacing: 1, marginBottom: 4 },
  playableItem: { flexDirection: "row", gap: 10, alignItems: "flex-start", backgroundColor: colors.surfaceHi, padding: 10, borderRadius: 10 },
  rankBadge: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.border, alignItems: "center", justifyContent: "center" },
  rankBadgeTop: { backgroundColor: colors.primary },
  rankTxt: { color: colors.textMuted, fontWeight: "900", fontSize: 12 },
  playableMarket: { color: colors.text, fontSize: 14, fontWeight: "900" },
  playableReason: { color: colors.textMuted, fontSize: 11, marginTop: 2, lineHeight: 16 },
  preBlock: { backgroundColor: colors.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: "rgba(255,140,0,0.35)", gap: 8 },
  preHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  preTitle: { color: colors.primary, fontSize: 12, fontWeight: "900", letterSpacing: 1, flex: 1 },
  preHint: { color: colors.textMuted, fontSize: 11, lineHeight: 16, marginBottom: 4 },
  preItem: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 10, backgroundColor: colors.surfaceHi, borderRadius: 10 },
  preItemConcord: { borderWidth: 1, borderColor: "rgba(16,185,129,0.45)", backgroundColor: "rgba(16,185,129,0.10)" },
  preRank: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.border, alignItems: "center", justifyContent: "center" },
  preRankTop: { backgroundColor: colors.primary },
  preRankTxt: { color: colors.textMuted, fontWeight: "900", fontSize: 11 },
  preMarket: { color: colors.text, fontSize: 13, fontWeight: "900" },
  preOdd: { color: colors.primary, fontSize: 12, fontWeight: "800" },
  preFamily: { color: colors.textDim, fontSize: 9, fontWeight: "800", letterSpacing: 0.5, textTransform: "uppercase" },
  concordTag: { flexDirection: "row", alignItems: "center", gap: 3, backgroundColor: "rgba(16,185,129,0.20)", borderWidth: 1, borderColor: "rgba(16,185,129,0.45)", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 },
  concordTxt: { color: "#10B981", fontSize: 9, fontWeight: "900", letterSpacing: 0.5 },
  wrTag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 },
  wrTxt: { fontSize: 9, fontWeight: "900", letterSpacing: 0.3 },
  aiBtn: { borderRadius: 12, overflow: "hidden" },
  aiBtnInner: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14 },
  aiBtnTxt: { color: "#FFF", fontSize: 14, fontWeight: "800" },
  regenBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    paddingVertical: 10, borderWidth: 1, borderColor: colors.primary,
    borderStyle: "dashed", borderRadius: 10, marginTop: 4,
  },
  regenBtnTxt: { color: colors.primary, fontSize: 12, fontWeight: "800", letterSpacing: 0.5 },
  sectionTitle: { color: colors.primary, fontSize: 11, fontWeight: "900", letterSpacing: 1, marginTop: 4 },
  famBlock: { gap: 8 },
  famName: { color: colors.text, fontSize: 13, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5 },
  famGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  famCard: {
    flex: 1, minWidth: 80, alignItems: "center", justifyContent: "center",
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: 10, paddingVertical: 12, position: "relative",
  },
  famCardTop: { backgroundColor: colors.primary, borderColor: colors.primary },
  famLbl: { color: colors.textMuted, fontSize: 10, fontWeight: "800", letterSpacing: 0.5 },
  famVal: { color: colors.text, fontSize: 18, fontWeight: "900", marginTop: 2 },
  famEst: { color: colors.textDim, fontSize: 8, fontWeight: "700", marginTop: 2 },
  topMark: { position: "absolute", top: 4, right: 4 },
  resultBlock: { gap: 8 },
  saveResultBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: colors.primary, paddingVertical: 14, borderRadius: 12, marginTop: 8,
  },
  saveResultTxt: { color: "#FFF", fontWeight: "900", fontSize: 14, letterSpacing: 0.5 },
});

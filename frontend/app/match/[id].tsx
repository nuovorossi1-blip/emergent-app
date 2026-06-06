import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, Alert,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";

import { api, Match, Prediction, MARKET_FAMILIES, ODD_LABELS, OddsKey, quickPredictionFamily, rankPicks, StructuralAnalysis, buildFinalVerdict, VerdictPick, getMarketOdd, filterCoherentAlternatives, violatesStructure } from "@/src/api";
import { useScrollMemory } from "@/src/utils/scrollMemory";
import { colors } from "@/src/theme";
import { ScoreInput } from "@/src/components/ScoreInput";
import { FamilyLegendModal } from "@/src/components/FamilyLegendModal";
import { predictionQueue } from "@/src/utils/predictionQueue";

export default function MatchDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const scrollMem = useScrollMemory(`/match/${id ?? "x"}`);
  const insets = useSafeAreaInsets();
  // Altezza approssimativa della BottomNav per posizionare la barra fissa sopra
  const navHeight = insets.bottom + 56 + 12;
  const [match, setMatch] = useState<Match | null>(null);
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [loading, setLoading] = useState(true);
  const [aiPending, setAiPending] = useState(false);
  const [result, setResult] = useState("");
  const [marketStats, setMarketStats] = useState<{ market: string; win_rate: number; total: number; family: string }[]>([]);
  const [yellowCandidates, setYellowCandidates] = useState<{ market: string; family: string; missed: number; family_total: number; miss_rate: number }[]>([]);
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [showLegend, setShowLegend] = useState(false);
  const [structural, setStructural] = useState<StructuralAnalysis | null>(null);
  const [showClusterAll, setShowClusterAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, stats, cands, struct] = await Promise.all([
        api.match(id!),
        api.marketStats().catch(() => ({ markets: [], family_totals: {} })),
        api.matchCandidates(id!).catch(() => ({ candidates: [], family: null, family_total: 0 })),
        api.matchStructural(id!).catch(() => null),
      ]);
      setMatch(m);
      setPrediction(m.prediction ?? null);
      setResult(m.result || "");
      setMarketStats(stats?.markets || []);
      setYellowCandidates(cands?.candidates || []);
      setStructural(struct as StructuralAnalysis | null);
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
    // Order is canonical (1, X, 2 / 1X, X2, 12 / U, O / GG, NG) — no sort
    // Find the index of the MOST PROBABLE market (lowest odd) to highlight with star
    let topIdx = -1;
    let minVal = Infinity;
    items.forEach((it, i) => {
      if (typeof it.value === "number" && it.value < minVal) {
        minVal = it.value;
        topIdx = i;
      }
    });
    return { name: fam.name, items, topIdx };
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

      <ScrollView contentContainerStyle={styles.content} {...scrollMem}>
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

        {/* ============ VERDETTO FINALE (fusione 3 sistemi) ============ */}
        {(() => {
          if (!structural) return null;
          const fam = quickPredictionFamily(match.odds);
          const llmMarkets = prediction?.playable_markets?.map((p) => p.market) || (prediction?.main_prediction ? [prediction.main_prediction] : []);
          const preRanked = rankPicks(fam, llmMarkets, marketStats);
          const verdictRaw = buildFinalVerdict(structural, preRanked, prediction?.playable_markets, match.odds);
          if (verdictRaw.length === 0) return null;
          // ============================================================
          // FILTRO STRUTTURALE: scarta picks che violano floor/ceiling
          // (es. MG 2-4 con floor=0, MG 1-3 con floor=2-tetto=4, U2.5 con tetto aperto)
          // Manteniamo il PICK migliore CONSENTITO, fallback al primo se filtraggio
          // azzera tutto (caso edge raro).
          // ============================================================
          const violatesFn = (m: string) => !!structural?.structure && violatesStructure(
            m,
            structural.structure.goal_floor,
            structural.structure.goal_ceiling,
            !!structural.structure.goal_ceiling_open,
          );
          const verdict = verdictRaw.filter((v) => !violatesFn(v.market));
          if (verdict.length === 0) return null;
          const top = verdict[0];
          // Alternative ordinate per concordanza DESC, poi score DESC.
          // POI filtrate per coerenza: scartano contraddizioni col PICK e
          // violazioni floor/ceiling (es. MG 2-X se floor=0, U3.5 se tetto aperto)
          const altsRaw = verdict
            .slice(1)
            .sort((a, b) => (b.concordance - a.concordance) || (b.score - a.score));
          const alts = filterCoherentAlternatives(top, altsRaw, structural?.structure, 3);

          const concColor = top.concordance === 3 ? colors.success
            : top.concordance === 2 ? colors.primary : colors.textDim;
          const concLabel = top.concordance === 3 ? "CONCORDANZA PIENA 3/3"
            : top.concordance === 2 ? "CONCORDANZA FORTE 2/3" : "SEGNALE PARZIALE 1/3";

          // Match concordance to result
          let pickOutcome: "won" | "lost" | null = null;
          if (match.result) {
            const parts = match.result.split("-").map((n) => parseInt(n, 10));
            if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
              const m = top.market.toUpperCase().replace(/\s/g, "");
              const home = parts[0], away = parts[1], total = home + away;
              let ok: boolean | null = null;
              if (m === "1") ok = home > away;
              else if (m === "X") ok = home === away;
              else if (m === "2") ok = away > home;
              else if (m.startsWith("1X")) ok = home >= away;
              else if (m.startsWith("X2")) ok = away >= home;
              else if (m.startsWith("12")) ok = home !== away;
              else if (m.startsWith("U")) { const n = parseFloat(m.match(/U(\d+(?:\.\d+)?)/)?.[1] || "0"); ok = total < n; }
              else if (m.startsWith("O")) { const n = parseFloat(m.match(/O(\d+(?:\.\d+)?)/)?.[1] || "0"); ok = total > n; }
              else if (m === "GG") ok = home > 0 && away > 0;
              else if (m === "NG") ok = home === 0 || away === 0;
              else if (m.includes("MG") && m.includes("2-4")) {
                if (m.includes("CASA")) ok = home >= 2 && home <= 4;
                else if (m.includes("OSPITE")) ok = away >= 2 && away <= 4;
                else ok = total >= 2 && total <= 4;
              }
              if (ok === true) pickOutcome = "won";
              else if (ok === false) pickOutcome = "lost";
            }
          }

          const rankBadges = (p: VerdictPick) => (
            <View style={{ flexDirection: "row", gap: 4, flexWrap: "wrap" }}>
              {p.ranks.structural && (
                <View style={[styles.vSrcBadge, { backgroundColor: colors.aiBg, borderColor: colors.aiText }]}>
                  <Ionicons name="construct" size={9} color={colors.aiText} />
                  <Text style={[styles.vSrcTxt, { color: colors.aiText }]}>STRUTT #{p.ranks.structural}</Text>
                </View>
              )}
              {p.ranks.ai && (
                <View style={[styles.vSrcBadge, { backgroundColor: "rgba(99,102,241,0.15)", borderColor: "#6366F1" }]}>
                  <Ionicons name="sparkles" size={9} color="#6366F1" />
                  <Text style={[styles.vSrcTxt, { color: "#6366F1" }]}>AI #{p.ranks.ai}</Text>
                </View>
              )}
              {p.ranks.pre && (
                <View style={[styles.vSrcBadge, { backgroundColor: "rgba(255,140,0,0.15)", borderColor: colors.primary }]}>
                  <Ionicons name="flash" size={9} color={colors.primary} />
                  <Text style={[styles.vSrcTxt, { color: colors.primary }]}>PRE #{p.ranks.pre}</Text>
                </View>
              )}
            </View>
          );

          return (
            <View style={[
              styles.verdictBlock,
              pickOutcome === "won" && { borderColor: colors.success, borderWidth: 2 },
              pickOutcome === "lost" && { borderColor: colors.danger, borderWidth: 2 },
            ]}>
              <View style={styles.verdictHeader}>
                <Ionicons name="trophy" size={16} color="#FFD700" />
                <Text style={styles.verdictTitle}>VERDETTO FINALE</Text>
                <View style={[styles.verdictConcTag, { borderColor: concColor }]}>
                  <Text style={[styles.verdictConcTxt, { color: concColor }]}>{concLabel}</Text>
                </View>
              </View>
              <Text style={styles.verdictHint}>Fusione pesata di Motore Strutturale (Poisson) + AI + Pre-pronostico locale</Text>

              <View style={styles.verdictHero}>
                <View style={styles.verdictMedal}>
                  <Ionicons name="medal" size={22} color="#FFF" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.verdictLabel}>GIOCATA CONSIGLIATA</Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
                    <Text style={styles.verdictMarket}>{top.market}</Text>
                    {top.odd && top.odd > 0 ? <Text style={styles.verdictOdd}>@ {top.odd.toFixed(2)}</Text> : null}
                    {pickOutcome === "won" && (
                      <View style={[styles.verdictOutcome, { backgroundColor: "rgba(16,185,129,0.20)", borderColor: colors.success }]}>
                        <Ionicons name="checkmark-circle" size={11} color={colors.success} />
                        <Text style={[styles.verdictOutcomeTxt, { color: colors.success }]}>VINTO</Text>
                      </View>
                    )}
                    {pickOutcome === "lost" && (
                      <View style={[styles.verdictOutcome, { backgroundColor: "rgba(239,68,68,0.20)", borderColor: colors.danger }]}>
                        <Ionicons name="close-circle" size={11} color={colors.danger} />
                        <Text style={[styles.verdictOutcomeTxt, { color: colors.danger }]}>PERSO</Text>
                      </View>
                    )}
                  </View>
                  <View style={{ marginTop: 6 }}>{rankBadges(top)}</View>
                  {top.coverage !== undefined && (
                    <Text style={styles.verdictMeta}>
                      Coverage {Math.round(top.coverage * 100)}% · Fragility {Math.round((top.fragility || 0) * 100)}%
                    </Text>
                  )}
                </View>
              </View>

              {alts.length > 0 && (
                <View style={{ marginTop: 4 }}>
                  <Text style={styles.verdictAltTitle}>ALTERNATIVE CONCORDI</Text>
                  {alts.map((a, i) => (
                    <View key={`v-${a.market}-${i}`} style={styles.verdictAltRow}>
                      <View style={styles.verdictAltRank}>
                        <Text style={styles.verdictAltRankTxt}>{i + 2}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <Text style={styles.verdictAltMarket}>{a.market}</Text>
                          {a.odd && a.odd > 0 ? <Text style={styles.verdictAltOdd}>@ {a.odd.toFixed(2)}</Text> : null}
                          <Text style={[styles.verdictConcMini, { color: a.concordance === 3 ? colors.success : a.concordance === 2 ? colors.primary : colors.textDim }]}>{a.concordance}/3</Text>
                          {a.vetoed && (
                            <TouchableOpacity
                              onPress={() => confirmAction({
                                title: "VETO STRUTTURALE",
                                message: "Il motore matematico (Poisson) ha RIFIUTATO questo mercato perché non rientra nei TOP-10 strutturali. L'AI e/o il Pre-pronostico lo suggeriscono ma il calcolo dice che è strutturalmente debole: la matematica delle quote indica che ha alta probabilità di essere rotto da un risultato fuori range.\n\nIn pratica: l'AI propone, la matematica veta.",
                                confirmText: "Ho capito",
                                cancelText: "Chiudi",
                                onConfirm: () => {},
                              })}
                              activeOpacity={0.7}
                            >
                              <View style={styles.vetoTag}>
                                <Ionicons name="warning" size={9} color="#FFF" />
                                <Text style={styles.vetoTxt}>VETO STRUTTURALE</Text>
                                <Ionicons name="information-circle-outline" size={10} color="#FFF" style={{ marginLeft: 2 }} />
                              </View>
                            </TouchableOpacity>
                          )}
                        </View>
                        <View style={{ marginTop: 4 }}>{rankBadges(a)}</View>
                      </View>
                    </View>
                  ))}
                </View>
              )}
            </View>
          );
        })()}

        {/* ============ STRUTTURA MATCH (Motore Strutturale) ============ */}
        {structural?.structure && (
          <View style={styles.structBlock}>
            <View style={styles.structHeader}>
              <Ionicons name="construct" size={14} color={colors.aiText} />
              <Text style={styles.structTitle}>STRUTTURA MATCH</Text>
              <View style={styles.structFamilyTag}>
                <Text style={styles.structFamilyTxt}>{structural.structure.family.replace(/_/g, " ")}</Text>
              </View>
            </View>
            <View style={styles.structGrid}>
              <View style={styles.structCell}>
                <Text style={styles.structLbl}>DOMINANZA</Text>
                <Text style={styles.structVal}>{(() => {
                  const d = structural.structure.dominance;
                  if (d === "strong_home") return "🏠 CASA NETTA";
                  if (d === "light_home") return "🏠 casa leggera";
                  if (d === "strong_away") return "✈️ OSPITE NETTA";
                  if (d === "light_away") return "✈️ ospite leggera";
                  return "⚖️ equilibrio";
                })()}</Text>
                <Text style={styles.structSub}>chi è favorito</Text>
              </View>
              <View style={styles.structCell}>
                <Text style={styles.structLbl}>PROFILO</Text>
                <Text style={styles.structVal}>{(() => {
                  const p = structural.structure.offensive_profile;
                  if (p === "reciprocity_high") return "💥 ESPLOSIVA";
                  if (p === "moderate") return "⚽ equilibrata";
                  if (p === "defensive") return "🛡️ DIFENSIVA";
                  return "▫ neutra";
                })()}</Text>
                <Text style={styles.structSub}>stile gol attesi</Text>
              </View>
              <View style={styles.structCell}>
                <Text style={styles.structLbl}>COMPRESSIONE</Text>
                <Text style={styles.structVal}>{(() => {
                  const c = structural.structure.goal_compression;
                  if (c === "high") return "🎯 alta";
                  if (c === "medium") return "📊 media";
                  return "🌐 bassa";
                })()}</Text>
                <Text style={styles.structSub}>quanto è stretto il range</Text>
              </View>
            </View>
            <View style={styles.structGrid}>
              <View style={styles.structCell}>
                <Text style={styles.structLbl}>PAVIMENTO</Text>
                <Text style={styles.structValBig}>{structural.structure.goal_floor}</Text>
                <Text style={styles.structSub}>gol min attesi</Text>
              </View>
              <View style={styles.structCell}>
                <Text style={styles.structLbl}>RANGE</Text>
                <Text style={styles.structValBig}>{structural.structure.goal_range}</Text>
                <Text style={styles.structSub}>gol totali</Text>
              </View>
              <View style={styles.structCell}>
                <Text style={styles.structLbl}>TETTO</Text>
                <Text style={[styles.structValBig, structural.structure.goal_ceiling_open && { color: colors.danger, fontSize: 18 }]}>
                  {structural.structure.goal_ceiling_open ? "APERTO" : structural.structure.goal_ceiling}
                </Text>
                <Text style={styles.structSub}>
                  {structural.structure.goal_ceiling_open ? "no max gol" : "gol max attesi"}
                </Text>
              </View>
            </View>
            <View style={styles.structLambdaRow}>
              <Text style={styles.structSub}>λ Poisson · Casa <Text style={styles.structLambda}>{structural.structure.lambda_home.toFixed(2)}</Text> · Ospite <Text style={styles.structLambda}>{structural.structure.lambda_away.toFixed(2)}</Text></Text>
            </View>
          </View>
        )}

        {/* ============ QUICK ACTIONS — RIMOSSI (ora nella BARRA FISSA in basso) ============ */}

        {/* ============ CLUSTER RISULTATI (Top probabili) ============ */}
        {structural?.cluster && structural.cluster.length > 0 && (() => {
          const list = showClusterAll ? structural.cluster : structural.cluster.slice(0, 8);
          const maxP = Math.max(...structural.cluster.map((c) => c.p)) || 1;
          const realScore = match.result || "";
          return (
            <View style={styles.clusterBlock}>
              <View style={styles.structHeader}>
                <Ionicons name="bar-chart" size={14} color={colors.aiText} />
                <Text style={styles.structTitle}>CLUSTER RISULTATI</Text>
                <Text style={styles.clusterHint}>Top {list.length} · cluster Poisson</Text>
              </View>
              {list.map((c, i) => {
                const pct = (c.p / maxP) * 100;
                const compColor = c.compatibility === "high" ? colors.success
                  : c.compatibility === "medium" ? colors.primary : colors.textDim;
                const isReal = realScore === c.score;
                return (
                  <View key={`cls-${c.score}-${i}`} style={[styles.clusterRow, isReal && styles.clusterRowReal]}>
                    <View style={styles.clusterRank}>
                      <Text style={styles.clusterRankTxt}>{i + 1}</Text>
                    </View>
                    <Text style={[styles.clusterScore, isReal && { color: colors.success }]}>{c.score}{isReal ? "  ✓" : ""}</Text>
                    <View style={styles.clusterBarTrack}>
                      <View style={[styles.clusterBarFill, { width: `${pct}%`, backgroundColor: compColor }]} />
                    </View>
                    <Text style={[styles.clusterPct, { color: compColor }]}>{(c.p * 100).toFixed(1)}%</Text>
                  </View>
                );
              })}
              {structural.cluster.length > 8 && (
                <TouchableOpacity onPress={() => setShowClusterAll(!showClusterAll)} style={styles.altToggle}>
                  <Ionicons name={showClusterAll ? "chevron-up" : "chevron-down"} size={14} color={colors.primary} />
                  <Text style={styles.altToggleTxt}>{showClusterAll ? "Mostra solo top 8" : `Vedi tutti i ${structural.cluster.length} risultati`}</Text>
                </TouchableOpacity>
              )}
              {structural.explanation && (
                <Text style={styles.clusterExpl}>{structural.explanation}</Text>
              )}
            </View>
          );
        })()}

        {/* ============ RANKING STRUTTURALE (Coverage + Fragility) ============ */}
        {structural?.ranking && structural.ranking.length > 0 && (() => {
          // Filter: only show markets with odd >= 1.40 (value threshold)
          // If odd cannot be derived (e.g. MG markets), keep them.
          const filtered = structural.ranking.filter((r) => {
            const o = getMarketOdd(r.market, match.odds);
            if (o === undefined) return true;
            return o >= 1.40;
          });
          if (filtered.length === 0) return null;
          return (
          <View style={styles.structRankBlock}>
            <View style={styles.structHeader}>
              <Ionicons name="ribbon" size={14} color={colors.aiText} />
              <Text style={styles.structTitle}>RANKING STRUTTURALE</Text>
              <Text style={styles.clusterHint}>Coverage × Fragility · quote ≥ 1.40</Text>
            </View>
            {filtered.map((r, i) => {
              const cov = Math.round(r.coverage * 100);
              const frag = Math.round(r.fragility * 100);
              const odd = getMarketOdd(r.market, match.odds);
              const fragColor = r.fragility_label === "bassa" ? colors.success
                : r.fragility_label === "media" ? colors.primary : colors.danger;
              return (
                <View key={`sr-${r.market}-${i}`} style={[styles.srRow, i === 0 && styles.srRowTop]}>
                  <View style={[styles.srRank, i === 0 && styles.srRankTop]}>
                    <Text style={[styles.srRankTxt, i === 0 && { color: "#FFF" }]}>{i + 1}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <Text style={[styles.srMarket, i === 0 && { color: colors.aiText }]}>{r.market}</Text>
                      {odd !== undefined && (
                        <Text style={[styles.srOdd, i === 0 && { color: colors.aiText }]}>@ {odd.toFixed(2)}</Text>
                      )}
                      <View style={[styles.srTag, { backgroundColor: "rgba(16,185,129,0.15)", borderColor: colors.success }]}>
                        <Text style={[styles.srTagTxt, { color: colors.success }]}>COV {cov}%</Text>
                      </View>
                      <View style={[styles.srTag, { backgroundColor: `${fragColor}22`, borderColor: fragColor }]}>
                        <Text style={[styles.srTagTxt, { color: fragColor }]}>FRAG {frag}%</Text>
                      </View>
                      {r.ml_adjustment && r.ml_adjustment.type !== "neutral" && (() => {
                        const isBoost = r.ml_adjustment.type === "boost";
                        const mlColor = isBoost ? colors.success : colors.danger;
                        const mlBg = isBoost ? "rgba(16,185,129,0.18)" : "rgba(239,68,68,0.18)";
                        return (
                          <View style={[styles.srTag, { backgroundColor: mlBg, borderColor: mlColor }]}>
                            <Ionicons name={isBoost ? "trending-up" : "trending-down"} size={9} color={mlColor} style={{ marginRight: 2 }} />
                            <Text style={[styles.srTagTxt, { color: mlColor }]}>ML {r.ml_adjustment.delta} ({r.ml_adjustment.win_rate}%, n={r.ml_adjustment.total})</Text>
                          </View>
                        );
                      })()}
                    </View>
                    {r.broken_by.length > 0 && (
                      <Text style={styles.srBroken}>Rotto da: {r.broken_by.join(", ")}</Text>
                    )}
                  </View>
                </View>
              );
            })}
          </View>
          );
        })()}

        {/* Pre-pronostic family — local heuristic */}
        {(() => {
          const fam = quickPredictionFamily(match.odds);
          if (fam.length === 0) return null;
          const llmMarkets = match.playable_markets?.map((p) => p.market) || (match.main_prediction ? [match.main_prediction] : []);
          const rankedRaw = rankPicks(fam, llmMarkets, marketStats);
          // ============================================================
          // FILTRO STRUTTURALE: scarta mercati che violano floor/ceiling
          // (es. MG 2-4 quando floor=0, MG 1-3 quando floor=2-tetto=4,
          // U2.5 quando ceiling aperto, MG con range non coerente)
          // ============================================================
          const ranked = structural?.structure
            ? rankedRaw.filter((p) => !violatesStructure(
                p.market,
                structural.structure.goal_floor,
                structural.structure.goal_ceiling,
                !!structural.structure.goal_ceiling_open,
              ))
            : rankedRaw;
          if (ranked.length === 0) return null;
          return (
            <View style={styles.preBlock}>
              <View style={styles.preHeader}>
                <Ionicons name="flash" size={14} color={colors.primary} />
                <Text style={styles.preTitle}>FAMIGLIA PRE-PRONOSTICO (locale)</Text>
                <TouchableOpacity onPress={() => setShowLegend(true)} style={styles.helpBtn} testID="open-legend">
                  <Ionicons name="help-circle-outline" size={18} color={colors.primary} />
                </TouchableOpacity>
              </View>
              <Text style={styles.preHint}>Mercati validi ordinati per affidabilità (concordanza AI + win-rate). Solo quote ≥ 1.40 e nessun segno 1/2/X se la quota corrispondente è &gt; 1.85.</Text>

              {/* RANK #1 - HIGHLIGHTED PICK */}
              {ranked[0] && (() => {
                const p = ranked[0];
                return (
                  <View style={styles.pickHero}>
                    <View style={styles.pickStar}><Ionicons name="star" size={18} color="#FFF" /></View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.pickLabel}>★ PICK CONSIGLIATO</Text>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                        <Text style={styles.pickMarket}>{p.market}</Text>
                        {p.odd > 0 && <Text style={styles.pickOdd}>@ {p.odd.toFixed(2)}</Text>}
                        <Text style={styles.pickFamily}>{p.family}</Text>
                        {p.source === "pre+ai" && (
                          <View style={styles.concordTag}>
                            <Ionicons name="checkmark-done" size={10} color="#10B981" />
                            <Text style={styles.concordTxt}>PRE+AI</Text>
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
                );
              })()}

              {/* YELLOW CANDIDATES - opportunità non sfruttate */}
              {yellowCandidates.map((c, i) => (
                <View key={`yc-${i}`} style={styles.yellowItem}>
                  <View style={styles.yellowIcon}><Ionicons name="bulb" size={12} color="#F59E0B" /></View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <Text style={styles.yellowMarket}>{c.market}</Text>
                      <Text style={styles.yellowFamily}>{c.family}</Text>
                      <Text style={styles.yellowDetail}>Opportunità non sfruttata: {c.missed}/{c.family_total} ({c.miss_rate}%)</Text>
                    </View>
                  </View>
                </View>
              ))}

              {/* Alternatives toggle */}
              {ranked.length > 1 && (
                <TouchableOpacity testID="toggle-alt" onPress={() => setShowAlternatives(!showAlternatives)} style={styles.altToggle}>
                  <Ionicons name={showAlternatives ? "chevron-up" : "chevron-down"} size={14} color={colors.primary} />
                  <Text style={styles.altToggleTxt}>{showAlternatives ? "Nascondi" : "Mostra"} {ranked.length - 1} alternative</Text>
                </TouchableOpacity>
              )}

              {/* Alternatives (rank 2..N) */}
              {showAlternatives && ranked.slice(1).map((p, idx) => {
                const i = idx + 1;
                return (
                <View key={i} style={[styles.preItem, { opacity: 0.7 }, p.source === "pre+ai" && styles.preItemConcord]}>
                  <View style={styles.preRank}>
                    <Text style={styles.preRankTxt}>{i + 1}</Text>
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
                );
              })}
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
            // Quando non c'è ancora pronostico: mostra solo placeholder, il bottone
            // "Genera Pronostico AI" sta nella BARRA FISSA in basso (vedi sotto).
            <View style={styles.aiPlaceholder}>
              <Ionicons name="sparkles-outline" size={28} color={colors.textDim} />
              <Text style={styles.aiPlaceholderTxt}>Tocca "Pronostico AI" in basso per generarlo</Text>
            </View>
          )}
        </View>

        <View style={{ height: 12 }} />
      </ScrollView>

      {/* ============================================================
          BARRA FISSA CONTESTUALE — RIMOSSA
          I 3 tasti AI/Risultato/Quote sono ora nella BottomNav stessa,
          che diventa contestuale automaticamente quando l'utente entra
          in una route /match/, /risultato/, /quote/.
       ============================================================ */}
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
  content: { padding: 16, paddingBottom: 200, gap: 16 },
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
  pickHero: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, backgroundColor: "rgba(255,140,0,0.15)", borderWidth: 2, borderColor: colors.primary, borderRadius: 14 },
  pickStar: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  pickLabel: { color: colors.primary, fontSize: 10, fontWeight: "900", letterSpacing: 1.5 },
  pickMarket: { color: colors.text, fontSize: 18, fontWeight: "900" },
  pickOdd: { color: colors.primary, fontSize: 14, fontWeight: "900" },
  pickFamily: { color: colors.textDim, fontSize: 9, fontWeight: "800", letterSpacing: 0.5, textTransform: "uppercase" },
  yellowItem: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 10, backgroundColor: "rgba(245,158,11,0.12)", borderWidth: 1, borderColor: "rgba(245,158,11,0.40)", borderRadius: 10 },
  yellowIcon: { width: 22, height: 22, borderRadius: 11, backgroundColor: "rgba(245,158,11,0.25)", alignItems: "center", justifyContent: "center" },
  yellowMarket: { color: "#F59E0B", fontSize: 13, fontWeight: "900" },
  yellowFamily: { color: colors.textDim, fontSize: 9, fontWeight: "800", letterSpacing: 0.5, textTransform: "uppercase" },
  yellowDetail: { color: colors.textMuted, fontSize: 11 },
  altToggle: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, paddingVertical: 8, marginTop: 4 },
  altToggleTxt: { color: colors.primary, fontSize: 11, fontWeight: "800" },
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

  // ===== STRUTTURA MATCH =====
  structBlock: {
    backgroundColor: colors.surface, borderRadius: 16, padding: 14,
    borderWidth: 1, borderColor: "rgba(99,102,241,0.40)", gap: 10,
  },
  structHeader: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  structTitle: { color: colors.aiText, fontSize: 12, fontWeight: "900", letterSpacing: 1, flex: 1 },
  structFamilyTag: { backgroundColor: colors.aiBg, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  structFamilyTxt: { color: colors.aiText, fontSize: 10, fontWeight: "900", letterSpacing: 0.5 },
  structGrid: { flexDirection: "row", gap: 8 },
  structCell: {
    flex: 1, backgroundColor: colors.surfaceHi, borderRadius: 10,
    paddingVertical: 10, paddingHorizontal: 8, alignItems: "center",
  },
  structLbl: { color: colors.textMuted, fontSize: 9, fontWeight: "800", letterSpacing: 0.8 },
  structVal: { color: colors.text, fontSize: 11, fontWeight: "800", marginTop: 4, textTransform: "uppercase" },
  structValBig: { color: colors.aiText, fontSize: 22, fontWeight: "900", marginTop: 2 },
  structSub: { color: colors.textDim, fontSize: 9, fontWeight: "600", marginTop: 2 },
  structLambdaRow: { alignItems: "center", paddingTop: 4, borderTopWidth: 1, borderTopColor: colors.border },

  // ===== QUICK ACTIONS (Genera Pronostico / Risultato + Quote) =====
  quickActions: {
    flexDirection: "row",
    gap: 10,
    marginVertical: 4,
  },
  qaBtnPrimary: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    backgroundColor: colors.primary,
    borderRadius: 12,
  },
  qaBtnPrimaryTxt: { color: "#000", fontWeight: "900", fontSize: 14 },
  qaBtnSecondary: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: 12,
  },
  qaBtnSecondaryTxt: { color: colors.primary, fontWeight: "800", fontSize: 13 },

  // ===== BARRA FISSA AZIONI (sopra BottomNav, contestuale match page) =====
  fixedActionBar: {
    position: "absolute",
    left: 12,
    right: 12,
    flexDirection: "row",
    gap: 8,
    zIndex: 20,
  },
  fabAction: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 12,
  },
  fabActionPrimary: {
    backgroundColor: colors.primary,
  },
  fabActionSecondary: {
    backgroundColor: "rgba(20,20,20,0.92)",
    borderWidth: 1,
    borderColor: colors.primary,
  },
  fabActionTxt: { color: "#000", fontWeight: "900", fontSize: 13 },
  aiPlaceholder: {
    alignItems: "center",
    paddingVertical: 16,
    gap: 6,
  },
  aiPlaceholderTxt: { color: colors.textDim, fontSize: 12, fontStyle: "italic" },
  structLambda: { color: colors.aiText, fontWeight: "900" },

  // ===== CLUSTER RISULTATI =====
  clusterBlock: {
    backgroundColor: colors.surface, borderRadius: 16, padding: 14,
    borderWidth: 1, borderColor: "rgba(99,102,241,0.40)", gap: 8,
  },
  clusterHint: { color: colors.textMuted, fontSize: 10, fontWeight: "700" },
  clusterRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingVertical: 6, paddingHorizontal: 8,
    backgroundColor: colors.surfaceHi, borderRadius: 8,
  },
  clusterRowReal: { borderWidth: 1, borderColor: colors.success, backgroundColor: "rgba(16,185,129,0.10)" },
  clusterRank: {
    width: 20, height: 20, borderRadius: 10, backgroundColor: colors.border,
    alignItems: "center", justifyContent: "center",
  },
  clusterRankTxt: { color: colors.textMuted, fontSize: 10, fontWeight: "900" },
  clusterScore: { color: colors.text, fontSize: 13, fontWeight: "900", width: 50 },
  clusterBarTrack: { flex: 1, height: 8, backgroundColor: colors.border, borderRadius: 4, overflow: "hidden" },
  clusterBarFill: { height: "100%", borderRadius: 4 },
  clusterPct: { fontSize: 11, fontWeight: "900", width: 50, textAlign: "right" },
  clusterExpl: {
    color: colors.textMuted, fontSize: 11, lineHeight: 16, marginTop: 6,
    paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border, fontStyle: "italic",
  },

  // ===== RANKING STRUTTURALE =====
  structRankBlock: {
    backgroundColor: colors.surface, borderRadius: 16, padding: 14,
    borderWidth: 1, borderColor: "rgba(99,102,241,0.40)", gap: 8,
  },
  srRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 8, paddingHorizontal: 10,
    backgroundColor: colors.surfaceHi, borderRadius: 10,
  },
  srRowTop: { borderWidth: 2, borderColor: colors.aiText, backgroundColor: colors.aiBg },
  srRank: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: colors.border,
    alignItems: "center", justifyContent: "center",
  },
  srRankTop: { backgroundColor: colors.aiText },
  srRankTxt: { color: colors.textMuted, fontSize: 11, fontWeight: "900" },
  srMarket: { color: colors.text, fontSize: 13, fontWeight: "900" },
  srOdd: { color: colors.primary, fontSize: 12, fontWeight: "800" },
  srTag: { borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 },
  srTagTxt: { fontSize: 9, fontWeight: "900", letterSpacing: 0.3 },
  srBroken: { color: colors.textDim, fontSize: 10, marginTop: 4, fontStyle: "italic" },

  // ===== VERDETTO FINALE =====
  verdictBlock: {
    backgroundColor: colors.surface, borderRadius: 16, padding: 14,
    borderWidth: 1, borderColor: "#FFD700", gap: 10,
  },
  verdictHeader: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  verdictTitle: { color: "#FFD700", fontSize: 13, fontWeight: "900", letterSpacing: 1.2, flex: 1 },
  verdictConcTag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  verdictConcTxt: { fontSize: 9, fontWeight: "900", letterSpacing: 0.5 },
  verdictHint: { color: colors.textMuted, fontSize: 10, lineHeight: 14, fontStyle: "italic" },
  verdictHero: {
    flexDirection: "row", gap: 12, alignItems: "center",
    backgroundColor: "rgba(255,215,0,0.10)", borderWidth: 1, borderColor: "rgba(255,215,0,0.40)",
    padding: 12, borderRadius: 12,
  },
  verdictMedal: { width: 40, height: 40, borderRadius: 20, backgroundColor: "#FFD700", alignItems: "center", justifyContent: "center" },
  verdictLabel: { color: "#FFD700", fontSize: 10, fontWeight: "900", letterSpacing: 1.5 },
  verdictMarket: { color: colors.text, fontSize: 20, fontWeight: "900" },
  verdictOdd: { color: "#FFD700", fontSize: 15, fontWeight: "900" },
  verdictOutcome: { flexDirection: "row", alignItems: "center", gap: 3, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5 },
  verdictOutcomeTxt: { fontSize: 10, fontWeight: "900", letterSpacing: 0.5 },
  verdictMeta: { color: colors.textMuted, fontSize: 10, marginTop: 4 },
  vSrcBadge: { flexDirection: "row", alignItems: "center", gap: 3, borderWidth: 1, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 },
  vSrcTxt: { fontSize: 9, fontWeight: "900", letterSpacing: 0.3 },
  verdictAltTitle: { color: colors.textMuted, fontSize: 9, fontWeight: "900", letterSpacing: 1, marginBottom: 6 },
  verdictAltRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 10, backgroundColor: colors.surfaceHi, borderRadius: 10, marginBottom: 6 },
  verdictAltRank: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.border, alignItems: "center", justifyContent: "center" },
  verdictAltRankTxt: { color: colors.textMuted, fontSize: 11, fontWeight: "900" },
  verdictAltMarket: { color: colors.text, fontSize: 13, fontWeight: "800" },
  verdictAltOdd: { color: colors.primary, fontSize: 12, fontWeight: "800" },
  verdictConcMini: { fontSize: 10, fontWeight: "900" },
  vetoTag: {
    flexDirection: "row", alignItems: "center", gap: 3,
    backgroundColor: colors.danger, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
  },
  vetoTxt: { color: "#FFF", fontSize: 9, fontWeight: "900", letterSpacing: 0.3 },
});

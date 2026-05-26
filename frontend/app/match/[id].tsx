import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";

import { api, Match, Prediction, MARKET_FAMILIES, ODD_LABELS, OddsKey } from "@/src/api";
import { colors } from "@/src/theme";

export default function MatchDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [match, setMatch] = useState<Match | null>(null);
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [loading, setLoading] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [result, setResult] = useState("");

  const load = useCallback(async () => {
    try {
      const m = await api.match(id!);
      setMatch(m);
      setPrediction(m.prediction ?? null);
      setResult(m.result || "");
    } catch (e: any) {
      Alert.alert("Errore", e?.message || "Caricamento");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const runPrediction = async () => {
    if (!id) return;
    setAiLoading(true);
    try {
      const p = await api.predict(id);
      setPrediction(p);
      await load();
    } catch (e: any) {
      Alert.alert("Errore AI", e?.message || "Impossibile generare");
    } finally {
      setAiLoading(false);
    }
  };

  const saveResult = async () => {
    if (!id || !result.trim()) return;
    try {
      await api.setResult(id, result.trim());
      Alert.alert("Salvato", "Risultato salvato");
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
        <TouchableOpacity testID="back-btn" onPress={() => router.back()} style={styles.iconBtn}>
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

        {/* AI prediction block */}
        <View style={styles.aiBlock}>
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
            </>
          ) : (
            <TouchableOpacity
              testID="gen-ai"
              onPress={runPrediction}
              disabled={aiLoading}
              style={styles.aiBtn}
              activeOpacity={0.85}
            >
              <LinearGradient
                colors={[colors.primaryLight, colors.primaryDark]}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                style={styles.aiBtnInner}
              >
                {aiLoading ? (
                  <ActivityIndicator color="#FFF" />
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
          <Text style={styles.sectionTitle}>RISULTATO</Text>
          <View style={styles.resultRow}>
            <TextInput
              testID="result-input"
              value={result}
              onChangeText={setResult}
              placeholder="es. 2-1"
              placeholderTextColor={colors.textDim}
              style={styles.resultInput}
            />
            <TouchableOpacity testID="save-result" onPress={saveResult} style={styles.saveBtn}>
              <Text style={styles.saveBtnTxt}>Salva</Text>
            </TouchableOpacity>
          </View>
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
  aiBtn: { borderRadius: 12, overflow: "hidden" },
  aiBtnInner: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14 },
  aiBtnTxt: { color: "#FFF", fontSize: 14, fontWeight: "800" },
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
  resultRow: { flexDirection: "row", gap: 8 },
  resultInput: {
    flex: 1, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: colors.text, fontSize: 15,
  },
  saveBtn: { backgroundColor: colors.primary, paddingHorizontal: 20, justifyContent: "center", borderRadius: 10 },
  saveBtnTxt: { color: "#FFF", fontWeight: "800" },
});

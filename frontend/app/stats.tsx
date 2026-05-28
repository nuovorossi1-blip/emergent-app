import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";

import { api } from "@/src/api";
import { colors } from "@/src/theme";
import BottomNav from "@/src/components/BottomNav";

type Score = { market: string; wins: number; losses: number; total: number; missed_wins?: number; win_rate: number };

export default function Stats() {
  const router = useRouter();
  const [data, setData] = useState<Record<string, Score[]>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.statsScores();
      setData(d);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const reset = () => {
    Alert.alert("Azzerare apprendimento?", "Tutti i punteggi delle famiglie verranno cancellati.", [
      { text: "Annulla", style: "cancel" },
      {
        text: "Azzera", style: "destructive",
        onPress: async () => { await api.statsReset(); load(); },
      },
    ]);
  };

  const families = Object.keys(data);
  const totalGames = families.reduce((s, f) => s + (data[f]?.reduce((x, sc) => x + sc.total, 0) || 0), 0);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity testID="stats-back" onPress={() => router.canGoBack() ? router.back() : router.replace("/profilo")} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Machine Learning</Text>
          <Text style={styles.subtitle}>Apprendimento dai risultati</Text>
        </View>
        <TouchableOpacity testID="stats-reset" onPress={reset} style={styles.iconBtn}>
          <Ionicons name="refresh-outline" size={20} color={colors.danger} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
      ) : families.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="bulb-outline" size={56} color={colors.textDim} />
          <Text style={styles.emptyTxt}>Nessun apprendimento ancora</Text>
          <Text style={styles.emptyHint}>Inserisci risultati per attivare il sistema di auto-correzione</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          <View style={styles.kpi}>
            <Text style={styles.kpiNum}>{totalGames}</Text>
            <Text style={styles.kpiLbl}>VALUTAZIONI TOTALI</Text>
          </View>

          {families.map((fam) => (
            <View key={fam} style={styles.famBlock}>
              <Text style={styles.famHeader}>{fam}</Text>
              {data[fam].map((sc) => (
                <View key={sc.market} style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.market}>{sc.market}</Text>
                    <Text style={styles.detail}>
                      {sc.wins}W / {sc.losses}L • {sc.total} valutazioni
                      {sc.missed_wins ? `  •  ${sc.missed_wins} opportunità perse` : ""}
                    </Text>
                  </View>
                  <View style={[
                    styles.rateBox,
                    sc.win_rate >= 60 && styles.rateGood,
                    sc.win_rate < 40 && sc.total > 0 && styles.rateBad,
                  ]}>
                    <Text style={styles.rateTxt}>{sc.total > 0 ? `${sc.win_rate}%` : "—"}</Text>
                  </View>
                </View>
              ))}
            </View>
          ))}
          <View style={{ height: 100 }} />
        </ScrollView>
      )}

      <BottomNav />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  iconBtn: { padding: 8 },
  title: { color: colors.text, fontSize: 20, fontWeight: "900", textAlign: "center" },
  subtitle: { color: colors.textMuted, fontSize: 11, textAlign: "center", marginTop: 2 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 32 },
  emptyTxt: { color: colors.textMuted, fontSize: 15, fontWeight: "700" },
  emptyHint: { color: colors.textDim, fontSize: 12, textAlign: "center" },
  list: { padding: 16, gap: 14 },
  kpi: { alignItems: "center", paddingVertical: 16, backgroundColor: colors.surface, borderRadius: 14, borderWidth: 1, borderColor: colors.border },
  kpiNum: { color: colors.primary, fontSize: 36, fontWeight: "900" },
  kpiLbl: { color: colors.textMuted, fontSize: 10, fontWeight: "800", letterSpacing: 1, marginTop: 4 },
  famBlock: { backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  famHeader: { color: colors.primary, fontSize: 11, fontWeight: "900", letterSpacing: 1, padding: 12, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surfaceHi },
  row: { flexDirection: "row", alignItems: "center", padding: 12, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 12 },
  market: { color: colors.text, fontSize: 13, fontWeight: "800" },
  detail: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  rateBox: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, backgroundColor: colors.surfaceHi, minWidth: 60, alignItems: "center" },
  rateGood: { backgroundColor: "rgba(16,185,129,0.20)" },
  rateBad: { backgroundColor: "rgba(239,68,68,0.18)" },
  rateTxt: { color: colors.text, fontWeight: "900", fontSize: 14 },
});

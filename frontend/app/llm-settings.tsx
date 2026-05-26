import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";

import { api } from "@/src/api";
import { colors } from "@/src/theme";
import BottomNav from "@/src/components/BottomNav";
import { openExternalUrl, confirmAction } from "@/src/utils/platform";

export default function LlmSettings() {
  const router = useRouter();
  const [options, setOptions] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [budget, setBudget] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [llm, bud] = await Promise.all([api.getLlmSettings(), api.getBudget()]);
      setOptions(llm.options);
      setSelectedId(llm.selected_id);
      setBudget(bud);
    } finally { setLoading(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const select = async (id: string) => {
    setSelectedId(id);
    try { await api.setLlmSettings(id); await load(); } catch (e: any) { Alert.alert("Errore", e?.message); }
  };

  const resetBudget = () => confirmAction({
    title: "Azzerare conteggio?", message: "Verrà azzerato il contatore di spesa stimato.", confirmText: "Azzera", destructive: true,
    onConfirm: async () => { await api.resetBudget(); load(); },
  });

  if (loading) return <SafeAreaView style={styles.safe}><ActivityIndicator color={colors.primary} style={{ marginTop: 60 }} /></SafeAreaView>;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}><Ionicons name="chevron-back" size={22} color={colors.text} /></TouchableOpacity>
        <Text style={styles.title}>LLM & Budget</Text>
        <TouchableOpacity onPress={resetBudget} style={styles.iconBtn}><Ionicons name="refresh-outline" size={20} color={colors.danger} /></TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={styles.list}>
        {/* Budget card */}
        {budget && (
          <View style={styles.budgetCard}>
            <Text style={styles.budgetLbl}>SPESA STIMATA (LOCALE)</Text>
            <Text style={styles.budgetVal}>${budget.estimated_spent_usd.toFixed(4)}</Text>
            <Text style={styles.budgetDetail}>{budget.predictions_made} pronostici · Modello: {budget.current_model}</Text>
            <Text style={styles.budgetDetail}>~ ${budget.cost_per_prediction_usd.toFixed(4)} per pronostico</Text>
            <TouchableOpacity onPress={() => openExternalUrl(budget.topup_url)} style={styles.topupBtn}>
              <Ionicons name="card-outline" size={16} color="#FFF" />
              <Text style={styles.topupTxt}>RICARICA EMERGENT KEY</Text>
            </TouchableOpacity>
            <Text style={styles.budgetHint}>Apre app.emergent.sh/chat → Profilo → Universal Key</Text>
          </View>
        )}
        <Text style={styles.section}>SCEGLI MODELLO LLM</Text>
        {options.map((o) => {
          const active = o.id === selectedId;
          return (
            <TouchableOpacity key={o.id} testID={`llm-${o.id}`} onPress={() => select(o.id)} style={[styles.opt, active && styles.optActive]}>
              <View style={[styles.radio, active && styles.radioOn]}>{active && <Ionicons name="checkmark" size={14} color="#FFF" />}</View>
              <View style={{ flex: 1 }}>
                <Text style={styles.optLabel}>{o.label}</Text>
                <Text style={styles.optDesc}>{o.desc}</Text>
                <View style={styles.optMeta}>
                  <Text style={styles.tag}>{o.speed}</Text>
                  <Text style={styles.tag}>{o.quality}</Text>
                  <Text style={styles.tagCost}>${o.cost_per_pred.toFixed(4)}/pred</Text>
                </View>
              </View>
            </TouchableOpacity>
          );
        })}
        <View style={{ height: 100 }} />
      </ScrollView>
      <BottomNav />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  iconBtn: { padding: 8 },
  title: { flex: 1, color: colors.text, fontSize: 18, fontWeight: "900", textAlign: "center" },
  list: { padding: 16, gap: 10 },
  budgetCard: { backgroundColor: colors.surface, borderRadius: 14, padding: 16, borderWidth: 1, borderColor: colors.border, alignItems: "center", gap: 6 },
  budgetLbl: { color: colors.textMuted, fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  budgetVal: { color: colors.primary, fontSize: 36, fontWeight: "900" },
  budgetDetail: { color: colors.textMuted, fontSize: 12 },
  topupBtn: { flexDirection: "row", gap: 6, backgroundColor: colors.primary, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 10, marginTop: 8 },
  topupTxt: { color: "#FFF", fontWeight: "900", fontSize: 12, letterSpacing: 0.5 },
  budgetHint: { color: colors.textDim, fontSize: 10, marginTop: 4 },
  section: { color: colors.primary, fontSize: 11, fontWeight: "900", letterSpacing: 1.5, marginTop: 12 },
  opt: { flexDirection: "row", gap: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, alignItems: "center" },
  optActive: { borderColor: colors.primary, backgroundColor: "rgba(255,140,66,0.08)" },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.borderLight, alignItems: "center", justifyContent: "center" },
  radioOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  optLabel: { color: colors.text, fontSize: 14, fontWeight: "900" },
  optDesc: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  optMeta: { flexDirection: "row", gap: 6, marginTop: 6 },
  tag: { backgroundColor: colors.surfaceHi, color: colors.textMuted, fontSize: 9, fontWeight: "700", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  tagCost: { backgroundColor: "rgba(255,140,66,0.15)", color: colors.primary, fontSize: 9, fontWeight: "800", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
});

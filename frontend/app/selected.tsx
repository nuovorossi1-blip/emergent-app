import React, { useCallback, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";

import { api, Match } from "@/src/api";
import { colors } from "@/src/theme";

export default function Selected() {
  const router = useRouter();
  const [items, setItems] = useState<Match[]>([]);
  const [results, setResults] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.selectedList();
      setItems(list);
      const r: Record<string, string> = {};
      list.forEach((m) => { if (m.result) r[m.id] = m.result; });
      setResults(r);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const removeFromSelection = async (id: string) => {
    setItems((arr) => arr.filter((x) => x.id !== id));
    try { await api.updateSelection([id], false); } catch {}
  };

  const clearAll = async () => {
    Alert.alert("Deseleziona tutto?", "", [
      { text: "Annulla", style: "cancel" },
      {
        text: "OK",
        onPress: async () => {
          await api.clearSelection();
          setItems([]);
        },
      },
    ]);
  };

  const saveAll = async () => {
    const payload = Object.entries(results)
      .filter(([, v]) => v.trim())
      .map(([id, result]) => ({ id, result: result.trim() }));
    if (payload.length === 0) {
      Alert.alert("Vuoto", "Inserisci almeno un risultato");
      return;
    }
    try {
      const out = await api.bulkResults(payload);
      Alert.alert("Salvato", `${out.updated} risultati aggiornati`);
    } catch (e: any) {
      Alert.alert("Errore", e?.message);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity testID="sel-back" onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Selezionate ({items.length})</Text>
        <TouchableOpacity testID="sel-clear" onPress={clearAll} style={styles.iconBtn}>
          <Ionicons name="trash-outline" size={20} color={colors.danger} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 60 }} />
      ) : items.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="albums-outline" size={56} color={colors.textDim} />
          <Text style={styles.emptyTxt}>Nessuna partita selezionata</Text>
        </View>
      ) : (
        <>
          <ScrollView contentContainerStyle={styles.list}>
            {items.map((m) => (
              <View key={m.id} style={styles.card}>
                <TouchableOpacity
                  testID={`sel-open-${m.id}`}
                  onPress={() => router.push(`/match/${m.id}`)}
                  style={styles.cardLeft}
                >
                  <Text style={styles.cardLeague}>{m.manifestazione}</Text>
                  <Text style={styles.cardTeams}>{m.squadra1} – {m.squadra2}</Text>
                  <Text style={styles.cardWhen}>{m.day} · {m.time}</Text>
                  {m.main_prediction && (
                    <View style={styles.predTag}>
                      <Text style={styles.predTagTxt}>{m.main_prediction}</Text>
                    </View>
                  )}
                </TouchableOpacity>
                <View style={styles.cardRight}>
                  <TextInput
                    testID={`sel-res-${m.id}`}
                    value={results[m.id] || ""}
                    onChangeText={(v) => setResults({ ...results, [m.id]: v })}
                    placeholder="2-1"
                    placeholderTextColor={colors.textDim}
                    style={styles.resInput}
                  />
                  <TouchableOpacity
                    testID={`sel-remove-${m.id}`}
                    onPress={() => removeFromSelection(m.id)}
                    style={styles.removeBtn}
                  >
                    <Ionicons name="close" size={16} color={colors.textMuted} />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
            <View style={{ height: 100 }} />
          </ScrollView>

          <View style={styles.footer}>
            <TouchableOpacity testID="save-all" onPress={saveAll} style={styles.saveAllBtn}>
              <Ionicons name="save" size={18} color="#FFF" />
              <Text style={styles.saveAllTxt}>Salva Tutti i Risultati</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  iconBtn: { padding: 8 },
  title: { flex: 1, color: colors.text, fontSize: 16, fontWeight: "800", textAlign: "center" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  emptyTxt: { color: colors.textMuted, fontSize: 14 },
  list: { padding: 16, gap: 10 },
  card: { flexDirection: "row", backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, gap: 10 },
  cardLeft: { flex: 1 },
  cardLeague: { color: colors.primary, fontSize: 10, fontWeight: "900", letterSpacing: 1, textTransform: "uppercase" },
  cardTeams: { color: colors.text, fontSize: 14, fontWeight: "800", marginTop: 2 },
  cardWhen: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  predTag: { alignSelf: "flex-start", backgroundColor: colors.aiBg, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, marginTop: 4 },
  predTagTxt: { color: colors.aiText, fontSize: 10, fontWeight: "800" },
  cardRight: { alignItems: "flex-end", gap: 6 },
  resInput: { width: 70, backgroundColor: colors.surfaceHi, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, color: colors.text, textAlign: "center", fontWeight: "700" },
  removeBtn: { padding: 4 },
  footer: { padding: 16, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bg },
  saveAllBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.primary, paddingVertical: 14, borderRadius: 12 },
  saveAllTxt: { color: "#FFF", fontWeight: "900", fontSize: 14, letterSpacing: 0.5 },
});

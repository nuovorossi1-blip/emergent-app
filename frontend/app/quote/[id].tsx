/**
 * PAGINA QUOTE DEDICATA (solo visualizzazione)
 * ===========================================
 * - Header: competizione, squadre, data + ora
 * - Tabelle quote per famiglia di mercato (Esito, DC, U/O 1.5/2.5/3.5, GG/NG)
 * - Stella sulla quota più bassa di ogni famiglia (favorita locale)
 */
import React, { useEffect, useState, useMemo } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, Match, MARKET_FAMILIES, ODD_LABELS } from "@/src/api";
import { colors } from "@/src/theme";
import BottomNav from "@/src/components/BottomNav";

export default function QuotePage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [match, setMatch] = useState<Match | null>(null);

  useEffect(() => {
    if (!id) return;
    let active = true;
    api.match(id as string).then((m) => { if (active) setMatch(m); }).catch(() => {});
    return () => { active = false; };
  }, [id]);

  const families = useMemo(() => {
    if (!match) return [];
    return MARKET_FAMILIES.map((f) => {
      const items = f.keys.map((k) => ({
        key: k,
        label: ODD_LABELS[k],
        value: match.odds?.[k as keyof typeof match.odds] as number | undefined,
      })).filter((it) => it.value !== undefined && it.value !== null);
      const topIdx = items.length > 0
        ? items.reduce((iMax, it, i, arr) => (it.value! < arr[iMax].value! ? i : iMax), 0)
        : -1;
      return { name: f.label, items, topIdx };
    });
  }, [match]);

  if (!id) return null;
  if (!match) return (
    <View style={[styles.container, { paddingTop: insets.top + 10 }]}>
      <Text style={styles.loadingTxt}>Caricamento…</Text>
    </View>
  );

  const ora = match.ora || "";
  const giorno = match.day || "";

  return (
    <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          {!!match.manifestazione && <Text style={styles.headerLeague}>{match.manifestazione}</Text>}
          <Text style={styles.headerTeams} numberOfLines={1}>
            {match.casa} <Text style={styles.headerVs}>vs</Text> {match.ospite}
          </Text>
          {(giorno || ora) ? <Text style={styles.headerTime}>{giorno}{giorno && ora ? " · " : ""}{ora}</Text> : null}
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.sectionTitle}>QUOTE PER FAMIGLIA</Text>
        {families.map((fam) => fam.items.length > 0 && (
          <View key={fam.name} style={styles.famBlock}>
            <Text style={styles.famName}>{fam.name}</Text>
            <View style={styles.famGrid}>
              {fam.items.map((it, idx) => {
                const isTop = idx === fam.topIdx;
                return (
                  <View key={it.key} style={[styles.famCard, isTop && styles.famCardTop]}>
                    <Text style={[styles.famLbl, isTop && { color: "#FFE4D9" }]}>{it.label}</Text>
                    <Text style={[styles.famVal, isTop && { color: "#FFF" }]}>{it.value!.toFixed(2)}</Text>
                    {isTop && (
                      <View style={styles.topMark}>
                        <Ionicons name="star" size={9} color="#FFF" />
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          </View>
        ))}
      </ScrollView>

      <BottomNav />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loadingTxt: { color: colors.textDim, fontSize: 16, textAlign: "center", marginTop: 100 },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 12, paddingBottom: 10, gap: 10,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  backBtn: { padding: 6 },
  headerLeague: { color: colors.primary, fontSize: 9, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" },
  headerTeams: { color: colors.text, fontSize: 15, fontWeight: "800", marginTop: 2 },
  headerVs: { color: colors.textDim, fontWeight: "600" },
  headerTime: { color: colors.textDim, fontSize: 10, marginTop: 2 },
  content: { padding: 14, paddingBottom: 200, gap: 14 },
  sectionTitle: { color: colors.text, fontSize: 12, fontWeight: "800", letterSpacing: 1 },
  famBlock: {
    backgroundColor: colors.card, borderRadius: 12, padding: 10,
    borderWidth: 1, borderColor: colors.border,
  },
  famName: { color: colors.textDim, fontSize: 10, fontWeight: "800", letterSpacing: 0.5, marginBottom: 6 },
  famGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  famCard: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
    backgroundColor: colors.background,
    borderWidth: 1, borderColor: colors.border,
    minWidth: 70, alignItems: "center", position: "relative",
  },
  famCardTop: { backgroundColor: colors.primary, borderColor: colors.primary },
  famLbl: { color: colors.textDim, fontSize: 10, fontWeight: "700" },
  famVal: { color: colors.text, fontSize: 14, fontWeight: "800", marginTop: 2 },
  topMark: { position: "absolute", top: -4, right: -4 },
});

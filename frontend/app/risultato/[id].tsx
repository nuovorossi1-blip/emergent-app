/**
 * PAGINA DEDICATA INSERIMENTO RAPIDO RISULTATO + QUOTE
 * ====================================================
 * - Top: input risultato grande (0-9 swipe-buttons per casa/ospite)
 * - Below: tabelle quote per famiglia di mercato (compatte)
 * - Bottom action: "Salva e prossima" → salta alla partita successiva selezionata
 *
 * Pensata per inserire risultati in serie, dopo la fine delle partite.
 * Workflow:
 *   1. apri da BottomNav o da match detail → vedi risultato + quote
 *   2. seleziona score con due tap (casa+ospite)
 *   3. tap "Salva e prossima" → ML aggiornato + naviga alla prossima
 */
import React, { useEffect, useState, useCallback, useMemo } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform, Alert } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, Match, MARKET_FAMILIES, ODD_LABELS, OddsKey } from "@/src/api";
import { colors } from "@/src/theme";
import { useToast } from "@/src/components/Toast";
import BottomNav from "@/src/components/BottomNav";

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export default function RisultatoPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const [match, setMatch] = useState<Match | null>(null);
  const [selectedMatches, setSelectedMatches] = useState<Match[]>([]);
  const [home, setHome] = useState<number | null>(null);
  const [away, setAway] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!id) return;
    let active = true;
    (async () => {
      try {
        const m = await api.match(id as string);
        if (!active) return;
        setMatch(m);
        // Pre-popola se già esiste risultato
        if (m.result) {
          const [h, a] = m.result.split("-").map((n) => parseInt(n, 10));
          if (!isNaN(h)) setHome(h);
          if (!isNaN(a)) setAway(a);
        }
      } catch (e) {
        console.warn("load match err", e);
      }
      try {
        const list = await api.selectedList();
        if (active) setSelectedMatches(list);
      } catch {}
    })();
    return () => { active = false; };
  }, [id]);

  // ============================================================
  // Trova prossima partita selezionata (per "Salva e prossima")
  // ============================================================
  const nextMatchId = useMemo(() => {
    if (!match || selectedMatches.length === 0) return null;
    const idx = selectedMatches.findIndex((m) => m.id === match.id);
    if (idx === -1) return selectedMatches[0]?.id ?? null;
    // Prendi la successiva, o ricomincia da capo
    const next = selectedMatches[idx + 1] || selectedMatches[0];
    return next?.id === match.id ? null : next.id;
  }, [match, selectedMatches]);

  const saveAndContinue = useCallback(async (goNext: boolean) => {
    if (!match) return;
    if (home === null || away === null) {
      toast.show("Seleziona prima casa e ospite", "error");
      return;
    }
    setSaving(true);
    try {
      const result = `${home}-${away}`;
      await api.setResult(match.id, result);
      toast.show(`✓ Risultato salvato: ${result}`, "success");
      if (goNext && nextMatchId) {
        // Reset stato e naviga
        setHome(null);
        setAway(null);
        router.replace(`/risultato/${nextMatchId}`);
      }
    } catch (e: any) {
      Alert.alert("Errore", e?.message || "Impossibile salvare");
    } finally {
      setSaving(false);
    }
  }, [match, home, away, nextMatchId, router, toast]);

  if (!id) return null;
  if (!match) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + 10 }]}>
        <Text style={styles.loadingTxt}>Caricamento…</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
      {/* HEADER */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTeams} numberOfLines={1}>
            {match.casa} <Text style={styles.headerVs}>vs</Text> {match.ospite}
          </Text>
          {!!match.manifestazione && (
            <Text style={styles.headerLeague} numberOfLines={1}>{match.manifestazione}</Text>
          )}
        </View>
        {selectedMatches.length > 0 && (
          <View style={styles.queueBadge}>
            <Ionicons name="layers" size={12} color={colors.primary} />
            <Text style={styles.queueBadgeTxt}>
              {Math.max(1, selectedMatches.findIndex((m) => m.id === match.id) + 1)}/{selectedMatches.length}
            </Text>
          </View>
        )}
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* RISULTATO BIG INPUT */}
        <View style={styles.scoreCard}>
          <Text style={styles.scoreLabel}>RISULTATO</Text>
          <View style={styles.scoreRow}>
            <ScoreSelector value={home} onChange={setHome} side="casa" />
            <Text style={styles.scoreDivider}>—</Text>
            <ScoreSelector value={away} onChange={setAway} side="ospite" />
          </View>
          <Text style={styles.scoreHint}>
            {home !== null && away !== null
              ? `Selezionato: ${home}-${away} (${home + away} gol totali)`
              : "Seleziona casa e ospite (0-9)"}
          </Text>
        </View>

        {/* QUOTE TABELLE */}
        <View style={styles.quotesBlock}>
          <Text style={styles.sectionTitle}>QUOTE</Text>
          {MARKET_FAMILIES.map((family) => (
            <View key={family.label} style={styles.familyCard}>
              <Text style={styles.familyLabel}>{family.label}</Text>
              <View style={styles.familyRow}>
                {family.keys.map((k: OddsKey) => {
                  const v = match.odds?.[k];
                  if (v === undefined || v === null) return null;
                  return (
                    <View key={k} style={styles.oddCell}>
                      <Text style={styles.oddKey}>{ODD_LABELS[k]}</Text>
                      <Text style={styles.oddVal}>{Number(v).toFixed(2)}</Text>
                    </View>
                  );
                })}
              </View>
            </View>
          ))}
        </View>
      </ScrollView>

      {/* ACTION BAR FISSA SOPRA BOTTOMNAV */}
      <View style={[styles.actionBar, { bottom: 96 + insets.bottom }]}>
        <TouchableOpacity
          onPress={() => saveAndContinue(false)}
          disabled={saving || home === null || away === null}
          style={[styles.btnSecondary, (saving || home === null || away === null) && styles.btnDisabled]}
        >
          <Ionicons name="save-outline" size={18} color={colors.text} />
          <Text style={styles.btnTxt}>Salva</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => saveAndContinue(true)}
          disabled={saving || home === null || away === null || !nextMatchId}
          style={[styles.btnPrimary, (saving || home === null || away === null || !nextMatchId) && styles.btnDisabled]}
        >
          <Text style={styles.btnTxtPrimary}>Salva → Prossima</Text>
          <Ionicons name="arrow-forward" size={18} color="#FFF" />
        </TouchableOpacity>
      </View>

      <BottomNav />
    </View>
  );
}

/**
 * Selettore digit 0-9 a scrollview orizzontale + bottoni grandi
 */
function ScoreSelector({ value, onChange, side }: { value: number | null; onChange: (n: number) => void; side: "casa" | "ospite" }) {
  return (
    <View style={styles.selectorWrap}>
      <Text style={styles.selectorSide}>{side === "casa" ? "🏠 CASA" : "✈️ OSPITE"}</Text>
      <View style={styles.selectedBigBox}>
        <Text style={styles.selectedBigTxt}>{value !== null ? value : "—"}</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.digitsRow}>
        {DIGITS.map((d) => {
          const active = value === d;
          return (
            <TouchableOpacity
              key={d}
              onPress={() => onChange(d)}
              style={[styles.digitBtn, active && styles.digitBtnActive]}
              activeOpacity={0.7}
            >
              <Text style={[styles.digitTxt, active && styles.digitTxtActive]}>{d}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  loadingTxt: { color: colors.textDim, fontSize: 16, textAlign: "center", marginTop: 100 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingBottom: 10,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backBtn: { padding: 6 },
  headerTeams: { color: colors.text, fontSize: 15, fontWeight: "800" },
  headerVs: { color: colors.textDim, fontWeight: "600" },
  headerLeague: { color: colors.textDim, fontSize: 10, marginTop: 2 },
  queueBadge: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 4,
    backgroundColor: "rgba(245,158,11,0.15)",
    borderRadius: 12, borderWidth: 1, borderColor: colors.primary,
  },
  queueBadgeTxt: { color: colors.primary, fontSize: 11, fontWeight: "800" },
  content: { padding: 14, paddingBottom: 200, gap: 14 },

  scoreCard: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 12,
  },
  scoreLabel: { color: colors.textDim, fontSize: 11, fontWeight: "800", letterSpacing: 1, textAlign: "center" },
  scoreRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-around", gap: 6 },
  scoreDivider: { color: colors.textDim, fontSize: 32, fontWeight: "800" },
  scoreHint: { color: colors.textDim, fontSize: 11, textAlign: "center", fontStyle: "italic" },

  selectorWrap: { alignItems: "center", flex: 1, gap: 6 },
  selectorSide: { color: colors.textDim, fontSize: 9, fontWeight: "800", letterSpacing: 0.5 },
  selectedBigBox: {
    width: 64, height: 64,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: colors.primary,
    backgroundColor: "rgba(245,158,11,0.12)",
    alignItems: "center", justifyContent: "center",
  },
  selectedBigTxt: { color: colors.primary, fontSize: 36, fontWeight: "900" },
  digitsRow: { gap: 6, paddingVertical: 4 },
  digitBtn: {
    minWidth: 36, height: 36,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    alignItems: "center", justifyContent: "center",
    paddingHorizontal: 8,
  },
  digitBtnActive: { borderColor: colors.primary, backgroundColor: colors.primary },
  digitTxt: { color: colors.text, fontSize: 16, fontWeight: "700" },
  digitTxtActive: { color: "#000" },

  quotesBlock: { gap: 8 },
  sectionTitle: {
    color: colors.text,
    fontSize: 13, fontWeight: "800", letterSpacing: 1, marginBottom: 4,
  },
  familyCard: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  familyLabel: { color: colors.textDim, fontSize: 10, fontWeight: "800", letterSpacing: 0.5, marginBottom: 6 },
  familyRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  oddCell: {
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.background,
    borderWidth: 1, borderColor: colors.border,
    minWidth: 60, alignItems: "center",
  },
  oddKey: { color: colors.textDim, fontSize: 10, fontWeight: "700" },
  oddVal: { color: colors.text, fontSize: 14, fontWeight: "800", marginTop: 2 },

  actionBar: {
    position: "absolute",
    left: 12, right: 12,
    flexDirection: "row",
    gap: 10,
    ...(Platform.OS === "web" ? { backdropFilter: "blur(8px)" as any } : {}),
  },
  btnSecondary: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
  },
  btnPrimary: {
    flex: 1.4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    backgroundColor: colors.primary,
    borderRadius: 12,
  },
  btnDisabled: { opacity: 0.4 },
  btnTxt: { color: colors.text, fontWeight: "800", fontSize: 14 },
  btnTxtPrimary: { color: "#000", fontWeight: "900", fontSize: 14 },
});

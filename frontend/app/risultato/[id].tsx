/**
 * PAGINA DEDICATA INSERIMENTO RAPIDO RISULTATO + QUOTE
 * ====================================================
 * - Top: HEADER con team + competizione + orario
 * - Quick-pick: 18 risultati comuni cliccabili (1 tap = imposta home+away)
 * - Score input manuale 0-9 (per casi limite)
 * - QUOTE COMPLETE per famiglia di mercato (spostate dalla pagina match)
 * - Action bar: Salva / Salva → Prossima (salta alla partita successiva)
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
// 18 risultati comuni nel calcio (raggruppati per popolarità)
const QUICK_RESULTS: Array<[number, number]> = [
  [0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [0, 2],
  [2, 1], [1, 2], [2, 2], [3, 0], [0, 3], [3, 1],
  [1, 3], [3, 2], [2, 3], [3, 3], [4, 0], [4, 1],
];

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
  const [showManual, setShowManual] = useState(false);

  useEffect(() => {
    if (!id) return;
    let active = true;
    (async () => {
      try {
        const m = await api.match(id as string);
        if (!active) return;
        setMatch(m);
        if (m.result) {
          const [h, a] = m.result.split("-").map((n) => parseInt(n, 10));
          if (!isNaN(h)) setHome(h);
          if (!isNaN(a)) setAway(a);
        }
      } catch (e) { console.warn(e); }
      try {
        const list = await api.selectedList();
        if (active) setSelectedMatches(list);
      } catch {}
    })();
    return () => { active = false; };
  }, [id]);

  const nextMatchId = useMemo(() => {
    if (!match || selectedMatches.length === 0) return null;
    const idx = selectedMatches.findIndex((m) => m.id === match.id);
    const next = selectedMatches[idx + 1] || selectedMatches[0];
    return next?.id === match.id ? null : next?.id ?? null;
  }, [match, selectedMatches]);

  const saveAndContinue = useCallback(async (goNext: boolean) => {
    if (!match) return;
    if (home === null || away === null) {
      toast.show("Seleziona prima il risultato", "error");
      return;
    }
    setSaving(true);
    try {
      const result = `${home}-${away}`;
      await api.setResult(match.id, result);
      toast.show(`✓ Salvato: ${result}`, "success");
      if (goNext && nextMatchId) {
        setHome(null); setAway(null);
        router.replace(`/risultato/${nextMatchId}`);
      }
    } catch (e: any) {
      Alert.alert("Errore", e?.message || "Impossibile salvare");
    } finally {
      setSaving(false);
    }
  }, [match, home, away, nextMatchId, router, toast]);

  const pickQuick = useCallback((h: number, a: number) => {
    setHome(h); setAway(a);
  }, []);

  // === Calcola gruppi quote stile match detail (con badge top quota minima) ===
  const families = useMemo(() => {
    if (!match) return [];
    return MARKET_FAMILIES.map((f) => {
      const items = f.keys.map((k) => ({
        key: k,
        label: ODD_LABELS[k],
        value: match.odds?.[k as keyof typeof match.odds] as number | undefined,
      })).filter((it) => it.value !== undefined && it.value !== null);
      // top = quota più bassa (favorito del gruppo)
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

  // Orario partita
  const ora = match.ora || (match.kickoff_iso ? new Date(match.kickoff_iso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "");
  const giorno = match.day || "";

  return (
    <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
      {/* HEADER */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          {!!match.manifestazione && <Text style={styles.headerLeague}>{match.manifestazione}</Text>}
          <Text style={styles.headerTeams} numberOfLines={1}>
            {match.casa} <Text style={styles.headerVs}>vs</Text> {match.ospite}
          </Text>
          {(giorno || ora) ? (
            <Text style={styles.headerTime}>{giorno}{giorno && ora ? " · " : ""}{ora}</Text>
          ) : null}
        </View>
        {selectedMatches.length > 0 && (
          <View style={styles.queueBadge}>
            <Ionicons name="layers" size={11} color={colors.primary} />
            <Text style={styles.queueBadgeTxt}>
              {Math.max(1, selectedMatches.findIndex((m) => m.id === match.id) + 1)}/{selectedMatches.length}
            </Text>
          </View>
        )}
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* RISULTATO BIG DISPLAY */}
        <View style={styles.scoreCard}>
          <Text style={styles.scoreLabel}>RISULTATO</Text>
          <View style={styles.scoreDisplay}>
            <View style={styles.scoreBig}>
              <Text style={styles.scoreSide}>🏠 CASA</Text>
              <Text style={styles.scoreVal}>{home !== null ? home : "—"}</Text>
            </View>
            <Text style={styles.scoreDivider}>—</Text>
            <View style={styles.scoreBig}>
              <Text style={styles.scoreSide}>✈️ OSPITE</Text>
              <Text style={styles.scoreVal}>{away !== null ? away : "—"}</Text>
            </View>
          </View>
          <Text style={styles.scoreHint}>
            {home !== null && away !== null
              ? `${home + away} gol totali`
              : "Tocca uno dei risultati qui sotto"}
          </Text>
        </View>

        {/* QUICK PICKS — risultati comuni */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>RISULTATI VELOCI</Text>
          <View style={styles.quickGrid}>
            {QUICK_RESULTS.map(([h, a]) => {
              const active = home === h && away === a;
              return (
                <TouchableOpacity
                  key={`${h}-${a}`}
                  onPress={() => pickQuick(h, a)}
                  style={[styles.quickPick, active && styles.quickPickActive]}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.quickPickTxt, active && styles.quickPickTxtActive]}>{h}-{a}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* TOGGLE MANUALE per gol > 4 */}
        <TouchableOpacity onPress={() => setShowManual((s) => !s)} style={styles.toggleManual} activeOpacity={0.7}>
          <Ionicons name={showManual ? "chevron-up" : "chevron-down"} size={14} color={colors.primary} />
          <Text style={styles.toggleManualTxt}>{showManual ? "Nascondi" : "Input manuale (per risultati 5+ gol)"}</Text>
        </TouchableOpacity>

        {showManual && (
          <View style={styles.manualSection}>
            <ManualSelector label="🏠 CASA" value={home} onChange={setHome} />
            <ManualSelector label="✈️ OSPITE" value={away} onChange={setAway} />
          </View>
        )}

        {/* QUOTE RIMOSSE: ora in pagina dedicata /quote/[id] */}
      </ScrollView>

      {/* ACTION BAR FISSA SOPRA BOTTOMNAV */}
      <View style={[styles.actionBar, { bottom: 96 + insets.bottom }]}>
        <TouchableOpacity
          onPress={() => saveAndContinue(false)}
          disabled={saving || home === null || away === null}
          style={[styles.btnSecondary, (saving || home === null || away === null) && styles.btnDisabled]}
          activeOpacity={0.8}
        >
          <Ionicons name="save-outline" size={16} color={colors.text} />
          <Text style={styles.btnTxt}>Salva</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => saveAndContinue(true)}
          disabled={saving || home === null || away === null || !nextMatchId}
          style={[styles.btnPrimary, (saving || home === null || away === null || !nextMatchId) && styles.btnDisabled]}
          activeOpacity={0.8}
        >
          <Text style={styles.btnTxtPrimary}>Salva → Prossima</Text>
          <Ionicons name="arrow-forward" size={16} color="#000" />
        </TouchableOpacity>
      </View>

      <BottomNav />
    </View>
  );
}

function ManualSelector({ label, value, onChange }: { label: string; value: number | null; onChange: (n: number) => void }) {
  return (
    <View style={styles.manualWrap}>
      <Text style={styles.manualLabel}>{label}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
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
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 12, paddingBottom: 10, gap: 10,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  backBtn: { padding: 6 },
  headerLeague: { color: colors.primary, fontSize: 9, fontWeight: "800", letterSpacing: 1, textTransform: "uppercase" },
  headerTeams: { color: colors.text, fontSize: 15, fontWeight: "800", marginTop: 2 },
  headerVs: { color: colors.textDim, fontWeight: "600" },
  headerTime: { color: colors.textDim, fontSize: 10, marginTop: 2 },
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
    borderRadius: 16, padding: 14,
    borderWidth: 1, borderColor: colors.border,
    gap: 10,
  },
  scoreLabel: { color: colors.textDim, fontSize: 10, fontWeight: "800", letterSpacing: 1, textAlign: "center" },
  scoreDisplay: { flexDirection: "row", alignItems: "center", justifyContent: "space-around", gap: 8 },
  scoreBig: { alignItems: "center", flex: 1, gap: 4 },
  scoreSide: { color: colors.textDim, fontSize: 9, fontWeight: "800" },
  scoreVal: { color: colors.primary, fontSize: 42, fontWeight: "900" },
  scoreDivider: { color: colors.textDim, fontSize: 32, fontWeight: "800" },
  scoreHint: { color: colors.textDim, fontSize: 11, textAlign: "center", fontStyle: "italic" },

  section: { gap: 8 },
  sectionTitle: { color: colors.text, fontSize: 12, fontWeight: "800", letterSpacing: 1 },

  quickGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  quickPick: {
    width: "15.4%", // 6 per riga
    aspectRatio: 1.2,
    borderRadius: 10,
    backgroundColor: colors.card,
    borderWidth: 1, borderColor: colors.border,
    alignItems: "center", justifyContent: "center",
  },
  quickPickActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  quickPickTxt: { color: colors.text, fontSize: 15, fontWeight: "800" },
  quickPickTxtActive: { color: "#000" },

  toggleManual: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
  toggleManualTxt: { color: colors.primary, fontSize: 12, fontWeight: "700" },

  manualSection: { gap: 10, marginTop: -4 },
  manualWrap: { gap: 6 },
  manualLabel: { color: colors.textDim, fontSize: 10, fontWeight: "800" },
  digitBtn: {
    width: 36, height: 36, borderRadius: 10,
    borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.background,
    alignItems: "center", justifyContent: "center",
  },
  digitBtnActive: { borderColor: colors.primary, backgroundColor: colors.primary },
  digitTxt: { color: colors.text, fontSize: 15, fontWeight: "700" },
  digitTxtActive: { color: "#000" },

  // Famiglie quote (stesso stile della match detail per consistency)
  famBlock: {
    backgroundColor: colors.card,
    borderRadius: 12, padding: 10,
    borderWidth: 1, borderColor: colors.border,
    marginBottom: 8,
  },
  famName: { color: colors.textDim, fontSize: 10, fontWeight: "800", letterSpacing: 0.5, marginBottom: 6 },
  famGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  famCard: {
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: colors.background,
    borderWidth: 1, borderColor: colors.border,
    minWidth: 60, alignItems: "center",
    position: "relative",
  },
  famCardTop: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  famLbl: { color: colors.textDim, fontSize: 10, fontWeight: "700" },
  famVal: { color: colors.text, fontSize: 14, fontWeight: "800", marginTop: 2 },
  topMark: { position: "absolute", top: -4, right: -4 },

  actionBar: {
    position: "absolute",
    left: 12, right: 12,
    flexDirection: "row",
    gap: 10,
    ...(Platform.OS === "web" ? { backdropFilter: "blur(8px)" as any } : {}),
  },
  btnSecondary: {
    flex: 1,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    paddingVertical: 14,
    backgroundColor: colors.card,
    borderWidth: 1, borderColor: colors.border,
    borderRadius: 12,
  },
  btnPrimary: {
    flex: 1.4,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    paddingVertical: 14,
    backgroundColor: colors.primary,
    borderRadius: 12,
  },
  btnDisabled: { opacity: 0.4 },
  btnTxt: { color: colors.text, fontWeight: "800", fontSize: 14 },
  btnTxtPrimary: { color: "#000", fontWeight: "900", fontSize: 14 },
});

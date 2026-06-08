import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { api, ODD_LABELS, OddsKey, SkippedRow, UploadSkippedReport } from "@/src/api";
import { colors, radii, spacing } from "@/src/theme";
import BottomNav from "@/src/components/BottomNav";

type FilterKind = "all" | "odds" | "teams" | "other";

const REQUIRED_LABELS: { key: OddsKey; label: string }[] = [
  { key: "odd_1", label: "1" },
  { key: "odd_X", label: "X" },
  { key: "odd_2", label: "2" },
  { key: "odd_O15", label: "O1.5" },
  { key: "odd_U15", label: "U1.5" },
  { key: "odd_O25", label: "O2.5" },
  { key: "odd_U25", label: "U2.5" },
  { key: "odd_O35", label: "O3.5" },
  { key: "odd_U35", label: "U3.5" },
  { key: "odd_GG", label: "GG" },
  { key: "odd_NG", label: "NG" },
];

function classify(reason: string): FilterKind {
  const r = reason.toLowerCase();
  if (r.includes("quote")) return "odds";
  if (r.includes("squadre")) return "teams";
  return "other";
}

function fmtUploadedAt(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

export default function Scartati() {
  const router = useRouter();
  const [data, setData] = useState<UploadSkippedReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKind>("all");

  const load = useCallback(async () => {
    try {
      setError(null);
      const out = await api.uploadSkipped();
      setData(out);
    } catch (e: any) {
      setError(e?.message || "Errore di caricamento");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (filter === "all") return data.skipped;
    return data.skipped.filter((r) => classify(r.reason) === filter);
  }, [data, filter]);

  const counts = useMemo(() => {
    if (!data) return { all: 0, odds: 0, teams: 0, other: 0 };
    const c = { all: data.skipped.length, odds: 0, teams: 0, other: 0 };
    for (const r of data.skipped) {
      const k = classify(r.reason);
      if (k === "odds") c.odds++;
      else if (k === "teams") c.teams++;
      else c.other++;
    }
    return c;
  }, [data]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Diagnostica Scarti</Text>
          <Text style={styles.subtitle}>Righe Excel rifiutate nell&apos;ultimo import</Text>
        </View>
        <TouchableOpacity style={styles.iconBtn} onPress={onRefresh}>
          <Ionicons name="refresh" size={20} color={colors.text} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      ) : error ? (
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={40} color={colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={load}>
            <Text style={styles.retryText}>Riprova</Text>
          </TouchableOpacity>
        </View>
      ) : !data || !data.uploaded_at ? (
        <View style={styles.center}>
          <Ionicons name="cloud-upload-outline" size={48} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>Nessun import recente</Text>
          <Text style={styles.emptyDesc}>Carica un file Excel da &quot;Strumenti&quot; e ritorna qui per vedere il dettaglio degli scarti.</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => router.push("/strumenti")}>
            <Text style={styles.retryText}>Vai a Strumenti</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        >
          {/* SUMMARY CARD */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="document-text-outline" size={18} color={colors.primary} />
              <Text style={styles.cardHeaderText}>Ultimo Import</Text>
            </View>
            <Text style={styles.fileName} numberOfLines={1}>{data.filename || "—"}</Text>
            <Text style={styles.fileMeta}>📅 {fmtUploadedAt(data.uploaded_at)}</Text>

            <View style={styles.statsRow}>
              <Stat label="Righe lette" value={data.rows_seen} />
              <Stat label="Valide" value={data.valid_matches} color={colors.success} />
              <Stat label="Scartate" value={data.skipped_count} color={colors.danger} />
            </View>
            <View style={styles.statsRow}>
              <Stat label="Nuove" value={data.inserted} />
              <Stat label="Aggiornate" value={data.updated} />
              <Stat label="Identiche" value={data.unchanged} />
            </View>
          </View>

          {/* REQUIRED ODDS LEGEND */}
          <View style={styles.legend}>
            <Text style={styles.legendTitle}>📋 Quote OBBLIGATORIE</Text>
            <Text style={styles.legendDesc}>
              Una riga viene scartata se manca anche una sola di queste quote. Le quote 1X/X2/12 vengono invece STIMATE (non obbligatorie).
            </Text>
            <View style={styles.legendChips}>
              {REQUIRED_LABELS.map((r) => (
                <View key={r.key} style={styles.legendChip}>
                  <Text style={styles.legendChipText}>{r.label}</Text>
                </View>
              ))}
            </View>
          </View>

          {/* FILTERS */}
          {data.skipped_count > 0 && (
            <View style={styles.filterRow}>
              <FilterChip label="Tutti" count={counts.all} active={filter === "all"} onPress={() => setFilter("all")} />
              <FilterChip label="Quote" count={counts.odds} active={filter === "odds"} onPress={() => setFilter("odds")} />
              <FilterChip label="Squadre" count={counts.teams} active={filter === "teams"} onPress={() => setFilter("teams")} />
              <FilterChip label="Altro" count={counts.other} active={filter === "other"} onPress={() => setFilter("other")} />
            </View>
          )}

          {/* LIST */}
          {data.skipped_count === 0 ? (
            <View style={styles.successBox}>
              <Ionicons name="checkmark-circle" size={48} color={colors.success} />
              <Text style={styles.successText}>Nessuna riga scartata 🎉</Text>
              <Text style={styles.successDesc}>Tutte le partite del file sono state importate correttamente.</Text>
            </View>
          ) : filtered.length === 0 ? (
            <View style={styles.successBox}>
              <Ionicons name="filter-outline" size={36} color={colors.textMuted} />
              <Text style={styles.emptyDesc}>Nessuna riga in questo filtro.</Text>
            </View>
          ) : (
            filtered.map((row, idx) => <SkippedCard key={`${row.row}-${idx}`} row={row} />)
          )}
        </ScrollView>
      )}
      <BottomNav />
    </SafeAreaView>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, color ? { color } : null]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function FilterChip({ label, count, active, onPress }: { label: string; count: number; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.filterChip, active && styles.filterChipActive]} onPress={onPress}>
      <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{label}</Text>
      <View style={[styles.countBadge, active && styles.countBadgeActive]}>
        <Text style={[styles.countBadgeText, active && styles.countBadgeTextActive]}>{count}</Text>
      </View>
    </TouchableOpacity>
  );
}

function SkippedCard({ row }: { row: SkippedRow }) {
  const kind = classify(row.reason);
  const accent = kind === "odds" ? colors.warning : kind === "teams" ? colors.danger : colors.textMuted;
  const presentKeys = Object.keys(row.odds_read || {}) as OddsKey[];
  const missingKeys = row.missing || [];

  return (
    <View style={[styles.rowCard, { borderLeftColor: accent }]}>
      <View style={styles.rowHeader}>
        <View style={styles.rowBadge}><Text style={styles.rowBadgeText}>Riga {row.row}</Text></View>
        {row.time ? <Text style={styles.rowTime}>🕒 {row.time}</Text> : null}
        {row.manif ? <Text style={styles.rowManif} numberOfLines={1}>· {row.manif}</Text> : null}
      </View>
      <Text style={styles.rowTeams} numberOfLines={2}>
        {(row.sq1 || "—") + "  vs  " + (row.sq2 || "—")}
      </Text>
      <View style={[styles.reasonBox, { borderColor: accent }]}>
        <Ionicons name="alert-circle-outline" size={16} color={accent} />
        <Text style={[styles.reasonText, { color: accent }]}>{row.reason}</Text>
      </View>

      {missingKeys.length > 0 && (
        <View style={styles.oddsRow}>
          <Text style={styles.oddsLabel}>❌ Mancanti</Text>
          <View style={styles.oddsChips}>
            {missingKeys.map((k) => (
              <View key={k} style={[styles.oddChip, styles.oddChipMissing]}>
                <Text style={[styles.oddChipText, styles.oddChipTextMissing]}>{ODD_LABELS[k] || k}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {presentKeys.length > 0 && (
        <View style={styles.oddsRow}>
          <Text style={styles.oddsLabel}>✓ Presenti</Text>
          <View style={styles.oddsChips}>
            {presentKeys.map((k) => (
              <View key={k} style={styles.oddChip}>
                <Text style={styles.oddChipText}>{ODD_LABELS[k] || k}</Text>
                <Text style={styles.oddChipValue}>{(row.odds_read || {})[k]?.toFixed(2)}</Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  backBtn: { padding: spacing.xs, marginRight: spacing.sm },
  iconBtn: { padding: spacing.xs },
  title: { color: colors.text, fontSize: 18, fontWeight: "700" },
  subtitle: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  body: { padding: spacing.lg, paddingBottom: 96 },
  center: { flex: 1, justifyContent: "center", alignItems: "center", padding: spacing.xl },
  errorText: { color: colors.danger, marginTop: spacing.md, textAlign: "center" },
  emptyTitle: { color: colors.text, fontSize: 17, fontWeight: "600", marginTop: spacing.md },
  emptyDesc: { color: colors.textMuted, marginTop: spacing.sm, textAlign: "center", paddingHorizontal: spacing.lg },
  retryBtn: {
    marginTop: spacing.lg,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xl, paddingVertical: spacing.md,
    borderRadius: radii.md,
  },
  retryText: { color: "#000", fontWeight: "700" },

  card: {
    backgroundColor: colors.surface,
    padding: spacing.lg, borderRadius: radii.lg,
    borderWidth: 1, borderColor: colors.border,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: spacing.sm },
  cardHeaderText: { color: colors.primary, fontWeight: "700", fontSize: 13, letterSpacing: 1 },
  fileName: { color: colors.text, fontSize: 16, fontWeight: "600", marginTop: 2 },
  fileMeta: { color: colors.textMuted, fontSize: 12, marginTop: 4, marginBottom: spacing.md },

  statsRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  stat: {
    flex: 1, alignItems: "center", paddingVertical: spacing.sm,
    backgroundColor: colors.surfaceHi, borderRadius: radii.md,
  },
  statValue: { color: colors.text, fontSize: 20, fontWeight: "700" },
  statLabel: { color: colors.textMuted, fontSize: 10, marginTop: 2, textTransform: "uppercase", letterSpacing: 0.5 },

  legend: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.aiBg,
    borderWidth: 1, borderColor: "rgba(96, 165, 250, 0.3)",
  },
  legendTitle: { color: colors.aiText, fontWeight: "700", fontSize: 13 },
  legendDesc: { color: colors.textMuted, fontSize: 12, marginTop: 4, lineHeight: 16 },
  legendChips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: spacing.sm },
  legendChip: {
    backgroundColor: colors.surfaceHi, paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: radii.sm, borderWidth: 1, borderColor: colors.borderLight,
  },
  legendChipText: { color: colors.text, fontSize: 11, fontWeight: "600" },

  filterRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: spacing.lg },
  filterChip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: spacing.md, paddingVertical: 8,
    backgroundColor: colors.surface, borderRadius: radii.full,
    borderWidth: 1, borderColor: colors.border,
  },
  filterChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterChipText: { color: colors.textMuted, fontSize: 12, fontWeight: "600" },
  filterChipTextActive: { color: "#000" },
  countBadge: {
    backgroundColor: colors.surfaceHi, paddingHorizontal: 6, paddingVertical: 1, borderRadius: radii.full,
  },
  countBadgeActive: { backgroundColor: "rgba(0,0,0,0.2)" },
  countBadgeText: { color: colors.textMuted, fontSize: 11, fontWeight: "700" },
  countBadgeTextActive: { color: "#000" },

  rowCard: {
    backgroundColor: colors.surface, padding: spacing.md, marginTop: spacing.md,
    borderRadius: radii.md, borderLeftWidth: 4, borderColor: colors.border, borderWidth: 1,
  },
  rowHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  rowBadge: { backgroundColor: colors.surfaceHi, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radii.sm },
  rowBadgeText: { color: colors.text, fontSize: 11, fontWeight: "700" },
  rowTime: { color: colors.textMuted, fontSize: 12 },
  rowManif: { color: colors.textDim, fontSize: 11, flex: 1 },
  rowTeams: { color: colors.text, fontSize: 14, fontWeight: "600", marginTop: 4 },

  reasonBox: {
    flexDirection: "row", alignItems: "center", gap: 6,
    marginTop: spacing.sm, padding: spacing.sm,
    borderRadius: radii.sm, borderWidth: 1,
    backgroundColor: colors.surfaceHi,
  },
  reasonText: { fontSize: 12, fontWeight: "600", flex: 1, flexShrink: 1 },

  oddsRow: { marginTop: spacing.sm },
  oddsLabel: { color: colors.textMuted, fontSize: 11, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  oddsChips: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  oddChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: colors.surfaceHi, paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: radii.sm, borderWidth: 1, borderColor: colors.borderLight,
  },
  oddChipMissing: { backgroundColor: "rgba(239, 68, 68, 0.1)", borderColor: colors.danger },
  oddChipText: { color: colors.text, fontSize: 11, fontWeight: "600" },
  oddChipTextMissing: { color: colors.danger },
  oddChipValue: { color: colors.success, fontSize: 11, fontWeight: "700" },

  successBox: {
    marginTop: spacing.xl, padding: spacing.xl,
    backgroundColor: colors.surface, borderRadius: radii.lg,
    alignItems: "center", borderWidth: 1, borderColor: colors.border,
  },
  successText: { color: colors.success, fontWeight: "700", fontSize: 16, marginTop: spacing.sm },
  successDesc: { color: colors.textMuted, marginTop: 6, textAlign: "center", fontSize: 13 },
});

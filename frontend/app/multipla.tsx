import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, TextInput, Switch,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { api, MultiplaLeg, MultiplaResponse } from "@/src/api";
import { colors } from "@/src/theme";
import { parseLeagueCode } from "@/src/utils/leagues";
import { useToast } from "@/src/components/Toast";
import { selectedListCache, matchesCache } from "@/src/utils/cache";

/**
 * Multipla automatica (18/09/2026). Rossi imposta partite e quota totale
 * minima; il motore sceglie le giocate piu' probabili del giorno, campionati
 * a scalare (principali -> secondari -> minori), e le mette in Schedina.
 *
 * Ogni gamba si puo' scartare in tre modi (cambia pronostico / cambia
 * partita / escludi il campionato per oggi); le altre gambe restano BLOCCATE
 * e il server ricompone solo il buco. La logica vive tutta in
 * netlify/functions/build-multipla.ts: qui solo interfaccia e stato.
 */

/**
 * I sei pattern scelti da Rossi il 19/09/2026. Sono tutti gia' nella whitelist
 * del verdetto, quindi selezionarli non forza il motore a proporre mercati che
 * Rossi aveva escluso. La chiave deve corrispondere a PATTERN_MARKETS in
 * netlify/functions/build-multipla.ts.
 */
const PATTERN_LIST = [
  { key: "1", label: "1" },
  { key: "2", label: "2" },
  { key: "O2.5", label: "Over 2.5" },
  { key: "GG", label: "GG" },
  { key: "1X", label: "1X" },
  { key: "X2", label: "X2" },
];

const TODAY = () => new Date().toLocaleString("sv-SE", { timeZone: "Europe/Rome" }).slice(0, 10);

export default function Multipla() {
  const router = useRouter();
  const toast = useToast();

  const [days, setDays] = useState<string[]>([]);
  const [day, setDay] = useState<string>(TODAY());
  const [events, setEvents] = useState(5);
  const [minTotal, setMinTotal] = useState("10");
  const [minOdd, setMinOdd] = useState<number | null>(null);
  /**
   * Pattern di mercato (19/09/2026). Nessuno selezionato = come prima, il
   * motore prende la giocata piu' probabile di ogni partita. Con uno o piu'
   * pattern, per ogni partita si guardano SOLO quei mercati: la multipla esce
   * dalle partite dove quei pattern reggono di piu'. Non c'e' una quota fissa
   * per tipo — scegliendo 1 e Over 2.5 possono uscire tutte "1", tutte "O2.5"
   * o un misto, secondo quello che offre la giornata.
   */
  const [patterns, setPatterns] = useState<string[]>([]);
  const [replace, setReplace] = useState(true);

  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [res, setRes] = useState<MultiplaResponse | null>(null);
  // Scelte di Rossi sulla proposta corrente: sopravvivono alle rigenerazioni.
  const [excludeMatches, setExcludeMatches] = useState<string[]>([]);
  const [excludeLeagues, setExcludeLeagues] = useState<string[]>([]);
  const [pickOverride, setPickOverride] = useState<Record<string, string>>({});

  useEffect(() => {
    api.days().then((d) => {
      const list = (d || []).filter((x) => x >= TODAY());
      setDays(list.length ? list : [TODAY()]);
      if (list.length && !list.includes(day)) setDay(list[0]);
    }).catch(() => {});
    api.getMinOdd().then((o) => setMinOdd(o.min_odd)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const minTotalNum = useMemo(() => {
    const n = Number(String(minTotal).replace(",", "."));
    return isFinite(n) && n >= 1 ? n : NaN;
  }, [minTotal]);

  /**
   * Genera o ricompone. `keep` = gambe da bloccare (quelle che Rossi non ha
   * scartato), con l'eventuale pronostico cambiato a mano.
   */
  const generate = useCallback(async (keep: MultiplaLeg[] = [], exM = excludeMatches, exL = excludeLeagues, overrides = pickOverride, pat = patterns) => {
    if (!isFinite(minTotalNum)) { toast.show("Quota minima non valida"); return; }
    setBusy(true);
    try {
      const r = await api.buildMultipla({
        day, events, minTotalOdd: minTotalNum, minProb: 0.45, maxPerLeague: 2,
        patterns: pat,
        locked: keep.map((l) => ({ matchId: l.match_id, market: overrides[l.match_id] || l.market })),
        excludeMatches: exM, excludeLeagues: exL,
      });
      setRes(r);
      if (r.error) toast.show(r.error);
    } catch (e: any) {
      toast.show(`Errore: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }, [day, events, minTotalNum, excludeMatches, excludeLeagues, pickOverride, patterns, toast]);

  const otherLegs = (id: string) => (res?.legs || []).filter((l) => l.match_id !== id);

  const changePick = (leg: MultiplaLeg) => {
    if (!leg.alternatives.length) { toast.show("Nessun altro pronostico sopra soglia per questa partita"); return; }
    // Passa all'alternativa successiva (in ordine di ranking); la partita resta.
    const next = leg.alternatives[0].market;
    const ov = { ...pickOverride, [leg.match_id]: next };
    setPickOverride(ov);
    generate(res?.legs || [], excludeMatches, excludeLeagues, ov);
  };

  const changeMatch = (leg: MultiplaLeg) => {
    const exM = [...excludeMatches, leg.match_id];
    setExcludeMatches(exM);
    generate(otherLegs(leg.match_id), exM, excludeLeagues, pickOverride);
  };

  const excludeLeague = (leg: MultiplaLeg) => {
    const exL = Array.from(new Set([...excludeLeagues, leg.manifestazione]));
    setExcludeLeagues(exL);
    generate((res?.legs || []).filter((l) => l.manifestazione !== leg.manifestazione), excludeMatches, exL, pickOverride);
  };

  const reset = () => {
    setExcludeMatches([]); setExcludeLeagues([]); setPickOverride({}); setRes(null);
  };

  const save = async () => {
    if (!res?.legs.length) return;
    setSaving(true);
    try {
      const r = await api.buildMultipla({
        day, events: res.legs.length, minTotalOdd: 1,
        locked: res.legs.map((l) => ({ matchId: l.match_id, market: l.market })),
        apply: true, replaceSelection: replace,
      });
      if (!r.applied) throw new Error(r.error || "non salvata");
      selectedListCache.invalidate?.();
      matchesCache.invalidate?.();
      toast.show(`Schedina aggiornata: ${r.legs.length} partite, quota ${fmtNum(r.total_odd)}`);
      router.push("/selected");
    } catch (e: any) {
      toast.show(`Salvataggio fallito: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity testID="multipla-back" onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Genera Multipla</Text>
        <View style={styles.iconBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {/* --- Impostazioni --- */}
        <Text style={styles.section}>GIORNO</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {days.map((d) => (
            <TouchableOpacity key={d} style={[styles.chip, d === day && styles.chipOn]} onPress={() => { setDay(d); reset(); }}>
              <Text style={[styles.chipTxt, d === day && styles.chipTxtOn]}>{fmtDay(d)}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <View style={styles.row}>
          <View style={styles.field}>
            <Text style={styles.label}>PARTITE</Text>
            <View style={styles.stepper}>
              <TouchableOpacity style={styles.stepBtn} onPress={() => setEvents((n) => Math.max(1, n - 1))}><Text style={styles.stepTxt}>−</Text></TouchableOpacity>
              <Text style={styles.stepVal}>{events}</Text>
              <TouchableOpacity style={styles.stepBtn} onPress={() => setEvents((n) => Math.min(8, n + 1))}><Text style={styles.stepTxt}>+</Text></TouchableOpacity>
            </View>
          </View>
          <View style={styles.field}>
            <Text style={styles.label}>QUOTA TOTALE MINIMA</Text>
            <TextInput
              testID="multipla-quota"
              style={styles.input}
              value={minTotal}
              onChangeText={setMinTotal}
              keyboardType="decimal-pad"
              placeholder="es. 10"
              placeholderTextColor={colors.textDim}
            />
          </View>
        </View>
        <View style={styles.field}>
          <Text style={styles.label}>PATTERN DI MERCATO</Text>
          <View style={styles.patternWrap}>
            {PATTERN_LIST.map((p) => {
              const on = patterns.includes(p.key);
              return (
                <TouchableOpacity
                  key={p.key}
                  testID={`multipla-pattern-${p.key}`}
                  onPress={() => setPatterns(on ? patterns.filter((x) => x !== p.key) : [...patterns, p.key])}
                  style={[styles.patternChip, on && styles.patternChipOn]}
                >
                  <Text style={[styles.patternTxt, on && styles.patternTxtOn]}>{p.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={styles.patternHint}>
            {patterns.length === 0
              ? "Nessuno selezionato: per ogni partita il motore sceglie la giocata più probabile, qualunque mercato sia."
              : `Ogni gamba sarà ${patterns.join(" o ")}: il motore sceglie, partita per partita, quello dei due che regge di più. Non c'è un numero fisso per tipo.`}
          </Text>
        </View>

        <Text style={styles.hint}>
          Servono gambe da circa @{isFinite(minTotalNum) ? Math.pow(minTotalNum, 1 / events).toFixed(2) : "—"} {"l'una."}
          Soglia per gamba {minOdd ? minOdd.toFixed(2) : "…"} (dalle Impostazioni), probabilità minima 45%, max 2 partite per campionato.
          Campionati a scalare: prima i principali, poi i secondari, poi i minori.
        </Text>

        <TouchableOpacity
          testID="multipla-genera"
          style={[styles.primaryBtn, (busy || !isFinite(minTotalNum)) && { opacity: 0.6 }]}
          disabled={busy || !isFinite(minTotalNum)}
          onPress={() => { reset(); generate([], [], [], {}); }}
        >
          {busy ? <ActivityIndicator color="#0A0A0A" /> : <Text style={styles.primaryTxt}>Genera</Text>}
        </TouchableOpacity>

        {/* --- Risultato --- */}
        {res && (
          <>
            <View style={[styles.summary, !res.ok && styles.summaryWarn]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.summaryTitle}>
                  {res.legs.length} {res.legs.length === 1 ? "partita" : "partite"} · quota {res.total_estimated ? "~" : ""}{fmtNum(res.total_odd)}
                </Text>
                <Text style={styles.summarySub}>
                  probabilità stimata {Math.round(res.total_prob * 100)}% · livelli usati: {res.tiers_used.map(tierName).join(", ") || "—"}
                </Text>
                {res.reason ? <Text style={styles.reason}>{res.reason}</Text> : null}
                {res.total_estimated ? <Text style={styles.note}>La tilde (~) indica quote stimate dal motore (multigol/combo): la quota reale la vedi sul book.</Text> : null}
              </View>
            </View>

            {res.legs.map((leg) => {
              const league = parseLeagueCode(leg.manifestazione);
              return (
                <View key={leg.match_id} style={styles.card}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardLeague}>{league.shortLabel} · {tierName(leg.tier)} · {leg.time}</Text>
                    <Text style={styles.cardTeams}>{leg.squadra1} - {leg.squadra2}</Text>
                    <View style={styles.pickRow}>
                      <Text style={styles.pick}>{leg.market}</Text>
                      <Text style={styles.odd}>@{fmtOdd(leg)}</Text>
                      <Text style={[styles.prob, { color: leg.prob >= 0.6 ? colors.success : leg.prob >= 0.5 ? colors.primary : colors.warning }]}>{Math.round(leg.prob * 100)}%</Text>
                      {leg.locked ? <Ionicons name="lock-closed" size={12} color={colors.textDim} /> : null}
                    </View>
                    {/* Lo storico VERO dal database, accanto alla stima del motore:
                        quante volte quel mercato e' uscito in partite lette allo
                        stesso modo dalle quote, e nelle partite concluse di quel
                        campionato. "—" quando il campione e' sotto le 20 partite:
                        una percentuale su pochi casi ingannerebbe e basta. */}
                    <Text style={styles.storico}>
                      storico — scenario: {leg.storico_scenario ? `${leg.storico_scenario.pct}% su ${leg.storico_scenario.total}` : "—"}
                      {"  ·  "}
                      {league.shortLabel}: {leg.storico_campionato ? `${leg.storico_campionato.pct}% su ${leg.storico_campionato.total}` : "—"}
                    </Text>
                    {leg.alternatives.length ? (
                      <Text style={styles.alts}>alternative: {leg.alternatives.map((a) => `${a.market} @${fmtOdd(a)}`).join(" · ")}</Text>
                    ) : null}
                  </View>
                  {/* Non mi piace: tre modi di scartare. Le altre gambe restano bloccate. */}
                  <View style={styles.cardActions}>
                    <TouchableOpacity testID={`multipla-pick-${leg.match_id}`} onPress={() => changePick(leg)} style={[styles.actionBtn, !leg.alternatives.length && { opacity: 0.4 }]} disabled={busy || !leg.alternatives.length}>
                      <Ionicons name="swap-horizontal-outline" size={16} color={colors.textMuted} />
                      <Text style={styles.actionTxt}>Altro pronostico</Text>
                    </TouchableOpacity>
                    <TouchableOpacity testID={`multipla-match-${leg.match_id}`} onPress={() => changeMatch(leg)} style={styles.actionBtn} disabled={busy}>
                      <Ionicons name="thumbs-down-outline" size={16} color={colors.textMuted} />
                      <Text style={styles.actionTxt}>Altra partita</Text>
                    </TouchableOpacity>
                    <TouchableOpacity testID={`multipla-league-${leg.match_id}`} onPress={() => excludeLeague(leg)} style={styles.actionBtn} disabled={busy}>
                      <Ionicons name="ban-outline" size={16} color={colors.textDim} />
                      <Text style={[styles.actionTxt, { color: colors.textDim }]}>No campionato</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}

            {(excludeMatches.length || excludeLeagues.length) ? (
              <Text style={styles.note}>
                Scartate: {excludeMatches.length} {excludeMatches.length === 1 ? "partita" : "partite"}
                {excludeLeagues.length ? ` · campionati esclusi oggi: ${excludeLeagues.join(", ")}` : ""}
              </Text>
            ) : null}

            <View style={styles.switchRow}>
              <Text style={styles.switchTxt}>Sostituisci la Schedina attuale</Text>
              <Switch value={replace} onValueChange={setReplace} trackColor={{ true: colors.primary, false: colors.border }} />
            </View>
            <TouchableOpacity
              testID="multipla-salva"
              style={[styles.primaryBtn, (saving || busy || !res.legs.length) && { opacity: 0.6 }]}
              disabled={saving || busy || !res.legs.length}
              onPress={save}
            >
              {saving ? <ActivityIndicator color="#0A0A0A" /> : <Text style={styles.primaryTxt}>Metti in Schedina</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => { reset(); generate([], [], [], {}); }} disabled={busy}>
              <Text style={styles.secondaryTxt}>Rigenera da zero</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function tierName(t: number) { return t === 1 ? "principale" : t === 2 ? "secondario" : "minore"; }
function fmtNum(n: number) { return (Math.round(n * 100) / 100).toFixed(2); }
function fmtOdd(x: { odd: number; odd_estimated: boolean }) { return `${fmtNum(x.odd)}${x.odd_estimated ? "~" : ""}`; }
function fmtDay(d: string) {
  if (d === TODAY()) return "Oggi";
  const [, m, g] = d.split("-");
  return `${g}/${m}`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  iconBtn: { padding: 8, width: 38 },
  title: { flex: 1, color: colors.text, fontSize: 16, fontWeight: "800", textAlign: "center" },
  body: { padding: 16, paddingBottom: 40, gap: 12 },
  section: { color: colors.textDim, fontSize: 11, fontWeight: "900", letterSpacing: 1.5 },
  chips: { gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  chipOn: { borderColor: colors.primary, backgroundColor: "rgba(255,140,66,0.15)" },
  chipTxt: { color: colors.textMuted, fontWeight: "700", fontSize: 13 },
  chipTxtOn: { color: colors.primary },
  row: { flexDirection: "row", gap: 12 },
  field: { flex: 1, gap: 6 },
  label: { color: colors.textDim, fontSize: 11, fontWeight: "900", letterSpacing: 1.5 },
  stepper: { flexDirection: "row", alignItems: "center", backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: "hidden" },
  stepBtn: { paddingHorizontal: 16, paddingVertical: 10 },
  stepTxt: { color: colors.primary, fontSize: 20, fontWeight: "900" },
  stepVal: { flex: 1, color: colors.text, fontSize: 18, fontWeight: "900", textAlign: "center" },
  input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, color: colors.text, fontSize: 18, fontWeight: "900", textAlign: "center" },
  hint: { color: colors.textDim, fontSize: 12, lineHeight: 17 },

  // Pattern di mercato: pastiglie a scelta multipla, vanno a capo da sole
  // cosi' reggono qualsiasi larghezza di schermo.
  patternWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  patternChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  patternChipOn: { borderColor: colors.primary, backgroundColor: "rgba(255,87,34,0.15)" },
  patternTxt: { color: colors.textMuted, fontSize: 13, fontWeight: "800" },
  patternTxtOn: { color: colors.primary },
  patternHint: { color: colors.textDim, fontSize: 11, lineHeight: 16, marginTop: 8 },
  primaryBtn: { backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  primaryTxt: { color: "#0A0A0A", fontWeight: "900", fontSize: 15 },
  secondaryBtn: { paddingVertical: 12, alignItems: "center" },
  secondaryTxt: { color: colors.textMuted, fontWeight: "700" },
  summary: { flexDirection: "row", backgroundColor: "rgba(16,185,129,0.1)", borderWidth: 1, borderColor: "rgba(16,185,129,0.4)", borderRadius: 12, padding: 12 },
  summaryWarn: { backgroundColor: "rgba(245,158,11,0.1)", borderColor: "rgba(245,158,11,0.4)" },
  summaryTitle: { color: colors.text, fontSize: 17, fontWeight: "900" },
  summarySub: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  reason: { color: "#FCD34D", fontSize: 12, marginTop: 6, lineHeight: 17 },
  note: { color: colors.textDim, fontSize: 11, lineHeight: 16, marginTop: 4 },
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, gap: 10 },
  cardLeague: { color: colors.primary, fontSize: 10, fontWeight: "900", letterSpacing: 1, textTransform: "uppercase" },
  cardTeams: { color: colors.text, fontSize: 15, fontWeight: "800", marginTop: 2 },
  pickRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  pick: { color: colors.text, fontSize: 14, fontWeight: "900" },
  odd: { color: colors.textMuted, fontSize: 13, fontWeight: "700" },
  prob: { fontSize: 13, fontWeight: "900" },
  alts: { color: colors.textDim, fontSize: 11, marginTop: 4 },
  storico: { color: colors.textMuted, fontSize: 11, marginTop: 4 },
  cardActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8 },
  actionBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, backgroundColor: colors.bg },
  actionTxt: { color: colors.textMuted, fontSize: 12, fontWeight: "700" },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 4 },
  switchTxt: { color: colors.textMuted, fontSize: 13 },
});

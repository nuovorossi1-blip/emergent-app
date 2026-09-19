import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
  TextInput, } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";

import { api, Match, Prediction, MARKET_FAMILIES, ODD_LABELS, OddsKey, quickPredictionFamily, rankPicks, StructuralAnalysis, buildFinalVerdict, VerdictPick, getMarketOdd, filterCoherentAlternatives, violatesStructure, getMatchCautionWarning, MatchHistory, getScenarioNote, isVerdictMarket } from "@/src/api";
import { marketStatsCache, mlStatsCache, matchDetailCache, oddSettingsCache, selectedListCache } from "@/src/utils/cache";
import { useScrollMemory } from "@/src/utils/scrollMemory";
import { colors } from "@/src/theme";
import { ScoreInput } from "@/src/components/ScoreInput";
import { FamilyLegendModal } from "@/src/components/FamilyLegendModal";
import { predictionQueue } from "@/src/utils/predictionQueue";
import BottomNav, { useNavMetrics } from "@/src/components/BottomNav";
import { confirmAction, notify } from "@/src/utils/platform";

/**
 * La soglia di quota si legge UNA VOLTA per sessione. Se due schermate la
 * chiedono insieme condividono la stessa promessa, cosi' non partono due
 * richieste per lo stesso numero.
 */
const ODD_FALLBACK = { min_odd: 1.40, options: [1.40, 1.50, 1.60, 1.75] };
let oddSettingsPromise: Promise<{ min_odd: number; options: number[] }> | null = null;

function getOddSettingsOnce(): Promise<{ min_odd: number; options: number[] }> {
  const cached = oddSettingsCache.get();
  if (cached) return Promise.resolve(cached);
  if (!oddSettingsPromise) {
    oddSettingsPromise = api.getMinOdd()
      .then((r) => {
        const v = {
          min_odd: r?.min_odd || ODD_FALLBACK.min_odd,
          options: r?.options?.length ? r.options : ODD_FALLBACK.options,
        };
        oddSettingsCache.set(v);
        return v;
      })
      .catch(() => {
        oddSettingsPromise = null; // un errore non deve congelare il fallback
        return ODD_FALLBACK;
      });
  }
  return oddSettingsPromise;
}

/** Le statistiche mercati sono le stesse per tutta l'app: se la cache della
 *  home e' ancora fresca non ha senso riscaricare 500 righe. */
function getMarketStatsCached(): Promise<{ markets: any[] }> {
  const c = marketStatsCache.get();
  if (c && !marketStatsCache.isStale()) return Promise.resolve({ markets: c });
  return api.marketStats()
    .then((s) => { marketStatsCache.set(s?.markets || []); return { markets: s?.markets || [] }; })
    .catch(() => ({ markets: marketStatsCache.get() || [] }));
}

export default function MatchDetail() {
  const { id, gen } = useLocalSearchParams<{ id: string; gen?: string }>();
  const router = useRouter();
  const scrollMem = useScrollMemory(`/match/${id ?? "x"}`);
  // Altezza REALE della BottomNav, presa dal suo stesso calcolo: prima era
  // stimata a mano qui e i due numeri non coincidevano, lasciando una
  // striscia di sfondo fra le due barre.
  const { height: navHeight } = useNavMetrics();
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
  const [history, setHistory] = useState<MatchHistory | null>(null);
  // FASE 2 — soglia di quota minima scelta dall'utente. Alzandola si compra
  // quota pagandola in precisione: misurato su 583 partite storiche,
  // 1,40 -> 62,3% | 1,50 -> 61,6% | 1,60 -> 54,0% | 1,75 -> 49,7%.
  const oddCached = oddSettingsCache.get();
  const [minOdd, setMinOdd] = useState<number>(oddCached?.min_odd ?? ODD_FALLBACK.min_odd);
  const [minOddOptions, setMinOddOptions] = useState<number[]>(oddCached?.options ?? ODD_FALLBACK.options);
  // Finche' non sappiamo la soglia vera non ha senso caricare: caricare col
  // default e poi rifare tutto e' esattamente il doppio caricamento che
  // rendeva lenta l'apertura di ogni partita.
  const [oddReady, setOddReady] = useState<boolean>(!!oddCached);
  // Lista delle partite in Schedina: serve a sapere qual e' la prossima.
  const [selList, setSelList] = useState<Match[]>((selectedListCache.get() as Match[]) || []);

  /** Riversa nello stato un pacchetto gia' pronto (dalla cache o dalla rete). */
  const applyBundle = useCallback((b: { match: any; cands: any; struct: any; hist: any }) => {
    setMatch(b.match);
    setPrediction(b.match?.prediction ?? null);
    setResult(b.match?.result || "");
    setYellowCandidates(b.cands?.candidates || []);
    setStructural(b.struct as StructuralAnalysis | null);
    setHistory(b.hist as MatchHistory | null);
  }, []);

  // STALE-WHILE-REVALIDATE, come gia' fa la home.
  //  - se il pacchetto e' in cache lo mostro SUBITO, senza spinner;
  //  - se e' ancora fresco (<5 min) non chiamo nemmeno il server;
  //  - se e' vecchio aggiorno in sottofondo, con i dati vecchi gia' a schermo.
  const load = useCallback(async (force = false) => {
    if (!id) return;
    const cached = matchDetailCache.get(id, minOdd);
    if (cached) {
      applyBundle(cached);
      setMarketStats(marketStatsCache.get() || []);
      setLoading(false);
      if (!force && !matchDetailCache.isStale(id, minOdd)) return;
    }
    try {
      const [m, stats, cands, struct, hist] = await Promise.all([
        api.match(id),
        getMarketStatsCached(),
        api.matchCandidates(id).catch(() => ({ candidates: [], family: null, family_total: 0 })),
        api.matchStructural(id, minOdd).catch(() => null),
        api.matchHistory(id).catch(() => null),
      ]);
      const bundle = { match: m, cands, struct, hist };
      matchDetailCache.set(id, minOdd, bundle);
      applyBundle(bundle);
      setMarketStats(stats?.markets || []);
    } catch (e: any) {
      // Con dati gia' a schermo un errore di rete non deve buttare un alert
      // in faccia: si tiene quello che c'e'.
      if (!cached) notify("Errore", e?.message || "Caricamento");
    } finally {
      setLoading(false);
    }
  }, [id, minOdd, applyBundle]);

  useEffect(() => { if (oddReady) load(); }, [load, oddReady]);

  // Soglia salvata nelle impostazioni: una volta per SESSIONE, non per partita.
  useEffect(() => {
    if (oddReady) return;
    let alive = true;
    getOddSettingsOnce().then((r) => {
      if (!alive) return;
      setMinOddOptions(r.options);
      setMinOdd(r.min_odd);
      setOddReady(true);
    });
    return () => { alive = false; };
  }, [oddReady]);

  const changeMinOdd = useCallback((value: number) => {
    setMinOdd(value);                 // il ricalcolo parte da solo: `load` dipende da minOdd
    const prev = oddSettingsCache.get();
    oddSettingsCache.set({ min_odd: value, options: prev?.options ?? ODD_FALLBACK.options });
    api.setMinOdd(value).catch(() => { /* la scelta vale comunque per questa sessione */ });
  }, []);

  // ============================================================
  // FASE 0 — salvataggio del verdetto finale.
  // Il verdetto viene calcolato durante il render (più sotto); qui lo
  // ricalcoliamo una volta sola, fuori dal render, per poterlo salvare senza
  // effetti collaterali dentro il JSX.
  // NOTA: le righe qui sotto devono restare allineate a quelle del blocco
  // "VERDETTO FINALE" nel render — se un giorno cambia la logica lì, va
  // cambiata anche qui, altrimenti si salva un pick diverso da quello mostrato.
  // ============================================================
  /** Riquadro mostrato quando nessun mercato coerente supera la soglia.
      Deve contenere COMUNQUE il selettore della quota: senza, l'utente non ha
      modo di abbassarla e resta bloccato su una schermata muta. */
  const renderNessunaGiocata = () => (
    <View style={styles.verdictBlock}>
      <Text style={styles.verdictTitle}>VERDETTO FINALE</Text>
      <View style={styles.minOddRow}>
        <Text style={styles.minOddLabel}>Quota minima</Text>
        <View style={styles.minOddChips}>
          {minOddOptions.map((v) => (
            <TouchableOpacity
              key={v}
              onPress={() => changeMinOdd(v)}
              style={[styles.minOddChip, minOdd === v && styles.minOddChipOn]}
            >
              <Text style={[styles.minOddChipTxt, minOdd === v && styles.minOddChipTxtOn]}>
                {v.toFixed(2)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>
      <View style={styles.sogliaWarn}>
        <Text style={styles.sogliaWarnTitle}>Nessuna giocata a quota {minOdd.toFixed(2)}</Text>
        <Text style={styles.sogliaWarnBody}>
          Sopra questa soglia non resta nessun mercato coerente con la lettura della partita.
          Abbassa la quota minima qui sopra per vedere cosa propone il motore.
        </Text>
      </View>
    </View>
  );

  const savedVerdictRef = useRef<string | null>(null);
  useEffect(() => {
    if (!match || !structural || match.result) return;
    try {
      // FASE 5 — se il backend manda la sua classifica PRE la usiamo: è una
      // sola implementazione invece di due copie da tenere allineate a mano.
      const fam = structural?.pre_ranking?.length
        ? structural.pre_ranking.map((c) => ({ market: c.market, odd: c.odd, family: "" }))
        : quickPredictionFamily(match.odds);
      const llmMarkets = prediction?.playable_markets?.map((p) => p.market)
        || (prediction?.main_prediction ? [prediction.main_prediction] : []);
      const preRanked = rankPicks(fam, llmMarkets, marketStats);
      const verdictRaw = buildFinalVerdict(structural, preRanked, prediction?.playable_markets, match.odds, history, { minOdd });
      const verdict = verdictRaw.filter((v) => !(structural.structure && violatesStructure(
        v.market,
        structural.structure.goal_floor,
        structural.structure.goal_ceiling,
        !!structural.structure.goal_ceiling_open,
      )));
      const top = verdict[0];
      if (!top || savedVerdictRef.current === top.market) return;
      savedVerdictRef.current = top.market;
      api.saveVerdict(match.id, top.market, top.coverage ?? undefined).catch(() => {
        // Best effort: se il salvataggio fallisce l'app resta identica.
        savedVerdictRef.current = null;
      });
    } catch {
      // Nessun impatto sul pronostico mostrato.
    }
  }, [match, structural, prediction, marketStats, history, minOdd]);

  // Subscribe to background prediction queue so the UI reflects in-flight requests
  useEffect(() => {
    if (!id) return;
    const updateState = async () => {
      const wasPending = predictionQueue.isPending(id);
      setAiPending(wasPending);
      // If a background prediction just finished, refresh the data
      if (!wasPending && match && !match.main_prediction && prediction === null) {
        try {
          const m = await api.match(id);
          setMatch(m);
          setPrediction(m.prediction ?? null);
          matchDetailCache.invalidate(id); // il pacchetto in cache non ha il pronostico appena arrivato
        } catch {}
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
          matchDetailCache.invalidate(id);
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
        matchDetailCache.invalidate(id);
        load(true);
      }
    });
  };

  // ============================================================
  // AUTO-GENERA quando l'utente tap "Pronostico AI" nel BottomNav
  // ============================================================
  // BottomNav passa ?gen=<timestamp> ogni click sul tab Pronostico AI
  // quando l'utente è già su questa pagina. Reagiamo lanciando la
  // generazione (force=true se esiste già una predizione = rigenera).
  useEffect(() => {
    if (!gen || !id || aiPending) return;
    runPrediction(!!prediction);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gen, id]);

  const saveResult = async () => {
    if (!id || !result.trim()) return;
    try {
      const out = await api.setResult(id, result.trim());
      marketStatsCache.invalidate();
      mlStatsCache.invalidate();
      matchDetailCache.invalidate(id);
      if (out.learning?.applied) {
        const ok = out.learning.result_ok;
        notify(
          ok ? "✓ Pronostico VINTO" : "✗ Pronostico PERSO",
          `Mercato: ${out.learning.main_prediction}\n\nIl sistema ha aggiornato i punteggi della famiglia di pronostico per migliorare le prossime previsioni.`,
        );
      } else {
        notify("Salvato", "Risultato salvato");
      }
      await load(true);
    } catch (e: any) {
      notify("Errore", e?.message);
    }
  };

  // ============================================================
  // SCORRIMENTO FRA LE PARTITE DELLA SCHEDINA (richiesta di Rossi, 10/09)
  // ============================================================
  // Aprendo una partita selezionata si restava bloccati li': per vedere la
  // successiva bisognava tornare indietro alla Schedina e riaprirla a mano.
  // La lista arriva dalla cache condivisa (la stessa gia' usata da Schedina e
  // schermata risultato), quindi nel caso normale non costa nessuna richiesta.
  useEffect(() => {
    let alive = true;
    const cached = selectedListCache.get() as Match[] | null;
    if (cached) setSelList(cached);
    if (!cached || selectedListCache.isStale()) {
      api.selectedList()
        .then((list) => { if (alive) { selectedListCache.set(list); setSelList(list); } })
        .catch(() => {});
    }
    return () => { alive = false; };
  }, [id]);

  const selIndex = id ? selList.findIndex((m) => m.id === id) : -1;
  const prevSel = selIndex > 0 ? selList[selIndex - 1] : null;
  const nextSel = selIndex >= 0 && selIndex < selList.length - 1 ? selList[selIndex + 1] : null;
  // `replace` e non `push`: scorrendo dieci partite non deve accumularsi una
  // pila di dieci schermate da smontare col tasto indietro.
  const goToSel = (m: Match | null) => { if (m) router.replace(`/match/${m.id}`); };

  // ============================================================
  // PRECARICAMENTO DELLA PARTITA SUCCESSIVA
  // ============================================================
  // Mentre Rossi legge questa partita, la connessione e' ferma. Usiamo quel
  // tempo morto per scaricare in sottofondo il pacchetto della prossima in
  // Schedina, cosi' premendo AVANTI compare istantanea invece di ricominciare
  // da cinque richieste. Se non preme AVANTI si e' sprecata una richiesta:
  // costo accettabile, perche' in una schedina si scorre quasi sempre avanti.
  //
  // Parte con 1,2 secondi di ritardo per non rubare banda al caricamento della
  // partita che si sta guardando adesso, che ha la precedenza.
  useEffect(() => {
    if (!oddReady || loading) return;
    const nid = nextSel?.id;
    if (!nid || matchDetailCache.get(nid, minOdd)) return;
    let alive = true;
    const timer = setTimeout(() => {
      Promise.all([
        api.match(nid),
        api.matchCandidates(nid).catch(() => ({ candidates: [], family: null, family_total: 0 })),
        api.matchStructural(nid, minOdd).catch(() => null),
        api.matchHistory(nid).catch(() => null),
      ])
        .then(([m, cands, struct, hist]) => {
          if (alive) matchDetailCache.set(nid, minOdd, { match: m, cands, struct, hist });
        })
        .catch(() => { /* il precaricamento non deve mai disturbare */ });
    }, 1200);
    return () => { alive = false; clearTimeout(timer); };
  }, [oddReady, loading, nextSel?.id, minOdd]);

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

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 96 }]} {...scrollMem}>
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

        {/* ============ NOTA SCENARIO 1X2 (richiesta da Rossi il 09/09) ============
            Calcolo separato e di sola lettura sulle quote gia' a sistema:
            non alimenta ne' modifica il verdetto finale, il motore, l'IA o
            lo storico. Solo promemoria dello scenario e dei mercati "da
            manuale" indicati per quello scenario. */}
        {(() => {
          const note = getScenarioNote(match.odds);
          if (!note) return null;
          return (
            <View style={styles.scenarioNoteBox}>
              <Text style={styles.scenarioNoteTitle}>SCENARIO: {note.scenario.toUpperCase()}</Text>
              <Text style={styles.scenarioNoteSub}>Mercati da considerare:</Text>
              {note.markets.map((m, i) => (
                <Text key={i} style={styles.scenarioNoteMarket}>• {m}</Text>
              ))}
            </View>
          );
        })()}

        {/* ============ VERDETTO FINALE (fusione 3 sistemi) ============ */}
        {(() => {
          if (!structural) return null;
          // FASE 5 — se il backend manda la sua classifica PRE la usiamo: è una
          // sola implementazione invece di due copie da tenere allineate a mano.
          const fam = structural?.pre_ranking?.length
            ? structural.pre_ranking.map((c) => ({ market: c.market, odd: c.odd, family: "" }))
            : quickPredictionFamily(match.odds);
          const llmMarkets = prediction?.playable_markets?.map((p) => p.market) || (prediction?.main_prediction ? [prediction.main_prediction] : []);
          const preRanked = rankPicks(fam, llmMarkets, marketStats);
          const verdictRaw = buildFinalVerdict(structural, preRanked, prediction?.playable_markets, match.odds, history, { minOdd });
          // NIENTE GIOCATA non vuol dire schermata vuota. Prima qui si usciva
          // con `return null` e spariva tutto il riquadro — selettore della
          // quota compreso: l'utente restava senza il comando per abbassare la
          // soglia e sbloccarsi. Ora il riquadro c'e' sempre, con il selettore
          // e la spiegazione al posto della giocata.
          if (verdictRaw.length === 0) return renderNessunaGiocata();
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
          if (verdict.length === 0) return renderNessunaGiocata();
          const top = verdict[0];
          // Alternative ordinate per concordanza DESC, poi score DESC.
          // POI filtrate per coerenza: scartano contraddizioni col PICK e
          // violazioni floor/ceiling (es. MG 2-X se floor=0, U3.5 se tetto aperto)
          const altsRaw = verdict
            .slice(1)
            .sort((a, b) => (b.concordance - a.concordance) || (b.score - a.score));
          const alts = filterCoherentAlternatives(top, altsRaw, structural?.structure, 3);
          const cautionWarning = getMatchCautionWarning(match.manifestazione, match.odds);

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

              {cautionWarning && (
                <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start", backgroundColor: "rgba(245,158,11,0.15)", borderColor: "#F59E0B", borderWidth: 1, borderRadius: 8, padding: 8, marginTop: 6 }}>
                  <Ionicons name="warning" size={14} color="#F59E0B" />
                  <Text style={{ color: "#F59E0B", fontSize: 11, flex: 1 }}>{cautionWarning}</Text>
                </View>
              )}

              {top.ambiguousPair && (
                <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start", backgroundColor: "rgba(245,158,11,0.15)", borderColor: "#F59E0B", borderWidth: 1, borderRadius: 8, padding: 8, marginTop: 6 }}>
                  <Ionicons name="warning" size={14} color="#F59E0B" />
                  <Text style={{ color: "#F59E0B", fontSize: 11, flex: 1 }}>Mercato scelto perché i due migliori candidati sono opposti e troppo vicini per essere affidabili da soli (vedi alternative).</Text>
                </View>
              )}

              {(history?.team_form?.home || history?.team_form?.away) && (
                <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start", backgroundColor: "rgba(59,130,246,0.12)", borderColor: "#3B82F6", borderWidth: 1, borderRadius: 8, padding: 8, marginTop: 6 }}>
                  <Ionicons name="stats-chart" size={14} color="#3B82F6" />
                  <Text style={{ color: "#3B82F6", fontSize: 11, flex: 1 }}>
                    Forma reale (solo informativa, non influenza il pick):{" "}
                    {history?.team_form?.home && `${match.squadra1} in casa: ${history.team_form.home.avg_scored} fatti / ${history.team_form.home.avg_conceded} subiti (${history.team_form.home.matches} partite)`}
                    {history?.team_form?.home && history?.team_form?.away && " · "}
                    {history?.team_form?.away && `${match.squadra2} in trasferta: ${history.team_form.away.avg_scored} fatti / ${history.team_form.away.avg_conceded} subiti (${history.team_form.away.matches} partite)`}
                  </Text>
                </View>
              )}

              {/* Avviso: fino a che soglia conviene spingersi SU QUESTA partita.
                  Non blocca niente — la scelta resta dell'utente — ma dice
                  quando alzare la soglia smette di comprare quota e inizia a
                  comprare solo rischio. */}
              {structural?.soglia_consigliata !== undefined && minOdd > (structural?.soglia_consigliata ?? 0) ? (
                <View style={styles.sogliaWarn}>
                  <Text style={styles.sogliaWarnTitle}>
                    {structural?.soglia_consigliata
                      ? `Su questa partita non conviene superare ${structural.soglia_consigliata.toFixed(2)}`
                      : "Su questa partita nessuna soglia offre un pick solido"}
                  </Text>
                  <Text style={styles.sogliaWarnBody}>
                    {(() => {
                      const d = structural?.soglie_dettaglio?.find((x) => Math.abs(x.soglia - minOdd) < 0.01);
                      return d
                        ? `A ${minOdd.toFixed(2)} il meglio disponibile è ${d.market} al ${d.prob}%.`
                        : `A ${minOdd.toFixed(2)} il meglio disponibile scende sotto il 58%.`;
                    })()}
                    {" "}Oltre il consiglio la riuscita misurata cala dal 59,7% al 55,7%.
                  </Text>
                </View>
              ) : null}

              {/* FASE 2 — soglia di quota minima: la scelta e' dell'utente */}
              <View style={styles.minOddRow}>
                <Text style={styles.minOddLabel}>Quota minima</Text>
                <View style={styles.minOddChips}>
                  {minOddOptions.map((v) => (
                    <TouchableOpacity
                      key={v}
                      onPress={() => changeMinOdd(v)}
                      style={[
                        styles.minOddChip,
                        minOdd === v && styles.minOddChipOn,
                        structural?.soglia_consigliata != null && v > structural.soglia_consigliata && styles.minOddChipOltre,
                      ]}
                    >
                      <Text style={[styles.minOddChipTxt, minOdd === v && styles.minOddChipTxtOn]}>
                        {v.toFixed(2)}
                        {structural?.soglia_consigliata != null && v > structural.soglia_consigliata ? " ⚠" : ""}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              <View style={styles.verdictHero}>
                <View style={styles.verdictMedal}>
                  <Ionicons name="medal" size={22} color="#FFF" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.verdictLabel}>GIOCATA CONSIGLIATA</Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
                    <Text style={styles.verdictMarket}>{top.market}</Text>
                    {top.odd && top.odd > 0 ? (
                      <Text style={styles.verdictOdd}>
                        {top.oddEstimated ? "≈ " : "@ "}{top.odd.toFixed(2)}
                        {top.oddEstimated ? " (stimata)" : ""}
                      </Text>
                    ) : null}
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
                                title: "SEGNALE STRUTTURALE DEBOLE",
                                message: "Il motore matematico (Poisson) non ha messo questo mercato nella sua top-6, quindi riceve una lieve penalità nel punteggio finale (non un'esclusione). L'AI e/o il Pre-pronostico lo suggeriscono comunque: se qui compare, è perché la concordanza tra i sistemi lo ha comunque portato in classifica.",
                                confirmText: "Ho capito",
                                cancelText: "Chiudi",
                                onConfirm: () => {},
                              })}
                              activeOpacity={0.7}
                            >
                              <View style={styles.vetoTag}>
                                <Ionicons name="warning" size={9} color="#FFF" />
                                <Text style={styles.vetoTxt}>SEGNALE DEBOLE</Text>
                                <Ionicons name="information-circle-outline" size={10} color="#FFF" style={{ marginLeft: 2 }} />
                              </View>
                            </TouchableOpacity>
                          )}
                          {a.ambiguousPair && (
                            <View style={[styles.vetoTag, { backgroundColor: "#F59E0B" }]}>
                              <Ionicons name="swap-horizontal" size={9} color="#FFF" />
                              <Text style={styles.vetoTxt}>OPPOSTO AL PICK</Text>
                            </View>
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
          // FASE 5 — se il backend manda la sua classifica PRE la usiamo: è una
          // sola implementazione invece di due copie da tenere allineate a mano.
          const fam = structural?.pre_ranking?.length
            ? structural.pre_ranking.map((c) => ({ market: c.market, odd: c.odd, family: "" }))
            : quickPredictionFamily(match.odds);
          if (fam.length === 0) return null;
          const llmMarkets = match.playable_markets?.map((p) => p.market) || (match.main_prediction ? [match.main_prediction] : []);
          // Solo i mercati che il pre-pronostico ha davvero in classifica:
          // rankPicks unisce anche quelli proposti dall'IA (marcati AI_ONLY), ma
          // mostrarli qui contraddice la didascalia — questa lista deve essere
          // il parere del pre-pronostico e basta. I mercati dell'IA hanno gia'
          // la loro sezione piu' sotto.
          const rankedRaw = rankPicks(fam, llmMarkets, marketStats).filter((r) => r.source !== "ai");
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
              <Text style={styles.preHint}>Mercati validi ordinati per quota reale del bookmaker e win-rate storico. Questa lista NON tiene conto del pronostico AI: resta un parere indipendente, così la concordanza fra i tre sistemi è reale e non un’eco.</Text>

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
              {/* La proposta dell'IA non e' il verdetto: se cade fuori dai mercati
                  che Rossi gioca (whitelist), va detto, non presentato come
                  equivalente al verdetto finale. */}
              {prediction.main_prediction && !isVerdictMarket(prediction.main_prediction) && (
                <View style={styles.aiFuoriWrap}>
                  <Ionicons name="information-circle-outline" size={14} color={colors.warning} />
                  <Text style={styles.aiFuoriTxt}>
                    Proposta IA fuori dai mercati giocati: non può diventare il verdetto finale.
                  </Text>
                </View>
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
            // Quando non c'è ancora pronostico: placeholder GRANDE e CLICCABILE
            // che fa partire la generazione AI direttamente.
            <TouchableOpacity
              testID="gen-ai-card"
              onPress={() => runPrediction(false)}
              disabled={aiPending}
              style={[styles.aiPlaceholder, aiPending && { opacity: 0.6 }]}
              activeOpacity={0.7}
            >
              {aiPending ? (
                <>
                  <ActivityIndicator color={colors.primary} size="large" />
                  <Text style={styles.aiPlaceholderTxt}>Generazione AI in corso…</Text>
                </>
              ) : (
                <>
                  <View style={styles.aiPlaceholderBtn}>
                    <Ionicons name="sparkles" size={20} color="#000" />
                    <Text style={styles.aiPlaceholderBtnTxt}>Genera Pronostico AI</Text>
                  </View>
                  <Text style={styles.aiPlaceholderTxt}>Tocca per generare il pronostico tramite DeepSeek</Text>
                </>
              )}
            </TouchableOpacity>
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
      {/* ============================================================
          BARRA DI SCORRIMENTO — IN FONDO, sopra la BottomNav
          ============================================================
          Prima stava sotto l'header, in cima: Rossi la cercava in fondo e non
          la trovava. Qui e' dove arriva il pollice, ed e' anche dove sta gia'
          "Salva -> Prossima" nella schermata risultato: stesso gesto, stesso
          posto. E' sempre presente, cosi' c'e' sempre una via d'uscita anche
          quando la partita non e' in Schedina; PREC e AVANTI compaiono solo
          quando c'e' davvero dove andare. */}
      <View style={[styles.selNavBar, { bottom: navHeight }]}>
        <TouchableOpacity
          testID="sel-exit"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
          style={styles.selNavBtn}
        >
          <Ionicons name="close" size={15} color={colors.text} />
          <Text style={styles.selNavTxt}>ESCI</Text>
        </TouchableOpacity>

        {selIndex >= 0 && selList.length > 1 ? (
          <>
            {/* PREC e' quadrato e senza etichetta: e' il gesto meno frequente
                e cosi' resta larghezza per AVANTI, che e' quello che si usa. */}
            <TouchableOpacity
              testID="sel-prev"
              onPress={() => goToSel(prevSel)}
              disabled={!prevSel}
              style={[styles.selNavBtn, styles.selNavBtnIcon, !prevSel && styles.selNavBtnOff]}
              accessibilityLabel="Partita precedente"
            >
              <Ionicons name="chevron-back" size={17} color={prevSel ? colors.text : colors.textDim} />
            </TouchableOpacity>

            <View style={styles.selNavCount}>
              <Ionicons name="ticket-outline" size={12} color={colors.primary} />
              <Text style={styles.selNavCountTxt}>{selIndex + 1}/{selList.length}</Text>
            </View>

            <TouchableOpacity
              testID="sel-next"
              onPress={() => goToSel(nextSel)}
              disabled={!nextSel}
              style={[styles.selNavBtn, styles.selNavBtnMain, !nextSel && styles.selNavBtnOff]}
            >
              <Text style={[styles.selNavTxt, nextSel ? { color: "#FFF" } : { color: colors.textDim }]}>AVANTI</Text>
              <Ionicons name="chevron-forward" size={15} color={nextSel ? "#FFF" : colors.textDim} />
            </TouchableOpacity>
          </>
        ) : (
          <Text style={styles.selNavHint} numberOfLines={1}>
            {selIndex >= 0 ? "Unica partita in Schedina" : "Partita non in Schedina"}
          </Text>
        )}
      </View>

      {/* La legenda delle famiglie era importata e il tasto "?" ne accendeva lo
          stato, ma il modale non veniva mai montato: il tasto non apriva nulla. */}
      <FamilyLegendModal visible={showLegend} onClose={() => setShowLegend(false)} />

      <BottomNav />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  // Tutti i tasti della barra hanno la STESSA altezza (SELNAV_H) e lo stesso
  // raggio: prima ognuno si dimensionava sul proprio contenuto e in fila
  // risultavano di misure diverse. Sfondo identico alla BottomNav, cosi' le
  // due barre si leggono come un unico blocco invece che come due fasce.
  selNavBar: {
    position: "absolute", left: 0, right: 0,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    gap: 6, paddingHorizontal: 10, paddingVertical: 7,
    backgroundColor: "rgba(10,10,10,0.96)",
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  selNavHint: { flex: 1, textAlign: "right", color: colors.textDim, fontSize: 11, fontWeight: "700" },
  selNavBtn: {
    height: 38, minWidth: 38,
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5,
    backgroundColor: colors.surfaceHi, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 14, borderRadius: 10,
  },
  selNavBtnIcon: { paddingHorizontal: 0, width: 38 },
  selNavBtnMain: { backgroundColor: colors.primary, borderColor: colors.primary },
  selNavBtnOff: { backgroundColor: colors.surface, borderColor: colors.border, opacity: 0.45 },
  selNavTxt: { color: colors.text, fontSize: 12, fontWeight: "900", letterSpacing: 0.6 },
  selNavCount: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 2 },
  selNavCountTxt: { color: colors.primary, fontSize: 13, fontWeight: "900", letterSpacing: 0.3 },
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
  aiPlaceholderBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.primaryLight,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 999,
    shadowColor: colors.primaryLight,
    shadowOpacity: 0.5,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  aiPlaceholderBtnTxt: { color: "#000", fontWeight: "900", fontSize: 15 },
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

  // ===== NOTA SCENARIO 1X2 (promemoria, sola lettura) =====
  scenarioNoteBox: {
    backgroundColor: colors.surface, borderRadius: 16, padding: 14,
    borderWidth: 1, borderColor: colors.textMuted, gap: 4,
  },
  scenarioNoteTitle: { color: colors.text, fontSize: 12, fontWeight: "900", letterSpacing: 0.8 },
  scenarioNoteSub: { color: colors.textMuted, fontSize: 10, marginTop: 2 },
  scenarioNoteMarket: { color: colors.textDim, fontSize: 11, lineHeight: 15 },

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
  sogliaWarn: {
    backgroundColor: "rgba(245,158,11,0.12)",
    borderWidth: 1,
    borderColor: "rgba(245,158,11,0.45)",
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
    gap: 3,
  },
  sogliaWarnTitle: { color: colors.warning, fontSize: 13, fontWeight: "800" },
  sogliaWarnBody: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  minOddChipOltre: { borderColor: "rgba(245,158,11,0.55)" },
  minOddRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 10,
    flexWrap: "wrap",
  },
  minOddLabel: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  minOddChips: { flexDirection: "row", gap: 6 },
  minOddChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
  },
  minOddChipOn: {
    backgroundColor: "rgba(255,140,66,0.20)",
    borderColor: colors.primary,
  },
  minOddChipTxt: { color: colors.textDim, fontSize: 12, fontWeight: "700" },
  minOddChipTxtOn: { color: "#FFF" },
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

  // Tasto "?" della legenda famiglie (era usato ma mai definito)
  helpBtn: { marginLeft: "auto", padding: 4 },

  aiFuoriWrap: {
    flexDirection: "row", alignItems: "center", gap: 6,
    marginTop: 8, paddingVertical: 6, paddingHorizontal: 8,
    backgroundColor: "rgba(245, 158, 11, 0.12)", borderRadius: 8,
  },
  aiFuoriTxt: { flex: 1, color: colors.warning, fontSize: 11, fontWeight: "700" },
});

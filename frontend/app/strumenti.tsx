import React, { useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Platform,
} from "react-native";
import { useBottomNav } from "@/src/components/BottomNavContext";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system/legacy";
import * as Clipboard from "expo-clipboard";

import { api } from "@/src/api";
import { colors } from "@/src/theme";
import BottomNav from "@/src/components/BottomNav";
import { confirmAction, notify, openExternalUrl } from "@/src/utils/platform";
import { matchesCache, daysCache } from "@/src/utils/cache";
import { AI_CHAT_URL, AI_MULTIPLA_PROMPT } from "@/src/utils/aiChat";
import { isAndroidBrowser, isAndroidShell, downloadLatestApk, RELEASE_LATEST_PAGE } from "@/src/utils/androidApp";

export default function Strumenti() {
  const bottomNav = useBottomNav();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  // Tasto "Installa app Android": solo nel browser di un telefono Android.
  // Dentro l'APK non ha senso (l'aggiornamento lo propone NativeUpdater),
  // su desktop il link alla pagina delle release basta e avanza.
  const showApkInstall = Platform.OS === "web" && !isAndroidShell();

  const uploadExcel = async () => {
    const res = await DocumentPicker.getDocumentAsync({
      type: [
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel",
        "*/*",
      ],
      copyToCacheDirectory: true,
    });
    if (res.canceled) return;
    const file = res.assets[0];
    setBusy("upload");
    try {
      const out = await api.uploadExcel(file.uri, file.name, file.mimeType);
      const skippedCount = out.skipped || 0;
      const lines = [
        `Nuove: ${out.inserted}`,
        `Aggiornate: ${out.updated}`,
        `Già presenti: ${out.unchanged ?? 0}`,
        `Valide totali: ${out.total_parsed}`,
        `Righe scartate: ${skippedCount}`,
      ];
      // Dopo un import le partite in memoria sono vecchie: senza questo la lista
      // continuava a mostrare i dati di prima e sembrava che l'import non avesse
      // fatto niente.
      matchesCache.invalidate();
      daysCache.invalidate();   // l'Excel puo' portare giornate nuove
      if (skippedCount > 0) {
        confirmAction({
          title: "Import completato",
          message: `${lines.join("\n")}\n\nVuoi vedere i dettagli degli scarti?`,
          confirmText: "Vedi scarti",
          cancelText: "Chiudi",
          onConfirm: () => router.push("/scartati"),
        });
      } else {
        notify("Import completato", lines.join("\n"));
      }
    } catch (e: any) {
      notify("Errore Import", e?.message || "Errore parser");
    } finally {
      setBusy(null);
    }
  };

  const exportBackup = async () => {
    setBusy("export");
    try {
      const data = await api.exportDb();
      const json = JSON.stringify(data, null, 2);
      const name = `scoreblast-backup-${new Date().toISOString().split("T")[0]}.json`;
      if (Platform.OS === "web") {
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
        notify("Esportato", "Download completato");
      } else {
        const path = `${FileSystem.cacheDirectory}${name}`;
        await FileSystem.writeAsStringAsync(path, json);
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(path, { mimeType: "application/json" });
        } else {
          notify("Salvato", path);
        }
      }
    } catch (e: any) {
      notify("Errore Export", e?.message);
    } finally {
      setBusy(null);
    }
  };

  const importBackup = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: "application/json", copyToCacheDirectory: true });
    if (res.canceled) return;
    setBusy("import");
    try {
      let text: string;
      if (Platform.OS === "web") {
        const r = await fetch(res.assets[0].uri);
        text = await r.text();
      } else {
        text = await FileSystem.readAsStringAsync(res.assets[0].uri);
      }
      const payload = JSON.parse(text);
      const out = await api.importDb(payload);
      notify(
        "Import Backup",
        `Partite importate: ${out.inserted_matches}\nDuplicati saltati: ${out.skipped_matches}\nPronostici: ${out.inserted_predictions}`,
      );
    } catch (e: any) {
      notify("Errore", e?.message);
    } finally {
      setBusy(null);
    }
  };

  /**
   * Tasto "Genera Multipla tramite AI".
   * Non dipende dalla Schedina: copia un prompt fisso con cui il modello cerca
   * da solo le partite del giorno e propone una multipla. Rossi poi seleziona
   * a mano nell'app quelle che gli interessano.
   */
  const openAIMultipla = async () => {
    setBusy("aimultipla");
    try {
      // La scheda va aperta PRIMA di qualunque await, altrimenti il browser la
      // blocca come popup (stessa trappola gia' nota su openAIStudio).
      let newWin: Window | null = null;
      if (Platform.OS === "web" && typeof window !== "undefined") {
        newWin = window.open(AI_CHAT_URL, "_blank", "noopener,noreferrer");
      }
      try {
        await Clipboard.setStringAsync(AI_MULTIPLA_PROMPT);
      } catch {
        if (Platform.OS === "web" && typeof navigator !== "undefined") {
          try { await (navigator as any).clipboard.writeText(AI_MULTIPLA_PROMPT); } catch {}
        }
      }
      if (Platform.OS !== "web") {
        openExternalUrl(AI_CHAT_URL);
      }
      if (Platform.OS === "web" && !newWin) {
        notify("Popup bloccato", "Abilita i popup per questo sito o apri manualmente " + AI_CHAT_URL + " e incolla con Ctrl+V.");
        return;
      }
      notify("Prompt Copiato ✓", "Incolla con Ctrl+V nella nuova scheda di TypingMind: cerchera' le partite di oggi e proporra' una multipla.");
    } catch (e: any) {
      notify("Errore", e?.message);
    } finally {
      setBusy(null);
    }
  };

  const openAIStudio = async () => {
    setBusy("aistudio");
    try {
      const { csv, count } = await api.aiStudioPrompt();
      if (count === 0) {
        notify("Nessuna partita selezionata", "Seleziona almeno una partita per usare il framework TypingMind.");
        return;
      }
      // 16/09/2026 — NIENTE PIU' INVOLUCRO.
      // Qui il prompt del server veniva infilato dentro AISTUDIO_FRAMEWORK
      // al posto di {{CSV}}: quel framework e' una consegna DIVERSA
      // ("raccoglitore dati web, non fare EV matematico") e si aspettava
      // una semplice tabella di quote. Ricevendo un prompt completo, il
      // modello si trovava due consegne opposte e seguiva la prima.
      // Il testo che arriva da /aistudio-prompt e' gia' completo di ruolo,
      // processo, formato di output e disclaimer: va incollato cosi' com'e'.
      const filled = csv;
      // CRITICAL: open the new tab BEFORE any async call (popup blocker)
      let newWin: Window | null = null;
      if (Platform.OS === "web" && typeof window !== "undefined") {
        newWin = window.open(AI_CHAT_URL, "_blank", "noopener,noreferrer");
      }
      try {
        await Clipboard.setStringAsync(filled);
      } catch {
        if (Platform.OS === "web" && typeof navigator !== "undefined") {
          try { await (navigator as any).clipboard.writeText(filled); } catch {}
        }
      }
      if (Platform.OS !== "web") {
        openExternalUrl(AI_CHAT_URL);
      }
      if (Platform.OS === "web" && !newWin) {
        notify("Popup bloccato", "Abilita i popup per questo sito o apri manualmente " + AI_CHAT_URL + " e incolla con Ctrl+V.");
        return;
      }
      notify("Prompt Copiato ✓", `${count} partite. Incolla con Ctrl+V nella nuova scheda di TypingMind.`);
    } catch (e: any) {
      notify("Errore", e?.message);
    } finally {
      setBusy(null);
    }
  };

  const downloadQuotePdf = () => {
    openExternalUrl("https://landing.sisal.it/volantini/Scommesse_Sport/Quote/calcio%20base%20per%20data.pdf");
  };

  const convertPdfToExcel = () => {
    openExternalUrl("https://www.ilovepdf.com/it/pdf_in_excel");
  };

  const deleteAll = () => {
    confirmAction({
      title: "Cancellare tutto?",
      message: "Verranno eliminate tutte le partite e i pronostici. Operazione irreversibile.",
      confirmText: "Conferma",
      destructive: true,
      onConfirm: async () => {
        await api.deleteAll();
        notify("Fatto", "Database svuotato");
      },
    });
  };

  type ToolProps = { icon: any; title: string; desc: string; onPress: () => void; testID: string; danger?: boolean };
  const Tool = ({ icon, title, desc, onPress, testID, danger }: ToolProps) => (
    <TouchableOpacity testID={testID} onPress={onPress} style={[styles.tool, danger && styles.toolDanger]} activeOpacity={0.85}>
      <View style={[styles.toolIcon, danger && { backgroundColor: "rgba(239,68,68,0.15)" }]}>
        <Ionicons name={icon} size={22} color={danger ? colors.danger : colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.toolTitle, danger && { color: colors.danger }]}>{title}</Text>
        <Text style={styles.toolDesc} numberOfLines={2}>{desc}</Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Strumenti</Text>
        <Text style={styles.subtitle}>Gestione import, backup e analisi esterna</Text>
      </View>

      <ScrollView contentContainerStyle={styles.list} onScroll={(e) => bottomNav.handleScroll(e.nativeEvent.contentOffset.y)} scrollEventThrottle={16}>
        <Text style={styles.section}>IMPORT DATI</Text>
        <Tool
          testID="tool-download-pdf"
          icon="cloud-download-outline"
          title="Scarica Quote PDF"
          desc="Apre il sito Sisal per scaricare il PDF aggiornato con le quote base."
          onPress={downloadQuotePdf}
        />
        <Tool
          testID="tool-pdf-to-excel"
          icon="swap-horizontal-outline"
          title="Converti PDF in Excel"
          desc="Apre iLovePDF per trasformare il PDF Sisal in file .xlsx."
          onPress={convertPdfToExcel}
        />
        <Tool
          testID="tool-upload"
          icon="cloud-upload-outline"
          title="Carica File Excel"
          desc="Importa partite e quote (.xls / .xlsx). Le esistenti vengono aggiornate solo se le quote cambiano."
          onPress={uploadExcel}
        />
        <Tool
          testID="tool-skipped"
          icon="warning-outline"
          title="Diagnostica Scarti"
          desc="Vedi le righe scartate nell'ultimo import e il motivo (quote mancanti, squadre, ecc.)."
          onPress={() => router.push("/scartati")}
        />
        <Tool
          testID="tool-import-backup"
          icon="download-outline"
          title="Importa Backup"
          desc="Carica un JSON esportato in precedenza (incrementale)."
          onPress={importBackup}
        />

        <Text style={styles.section}>BACKUP</Text>
        <Tool
          testID="tool-export-backup"
          icon="archive-outline"
          title="Esporta Backup"
          desc="Scarica JSON con tutte le partite e pronostici. Trasferibile su altro account."
          onPress={exportBackup}
        />

        <Text style={styles.section}>AI & BUDGET</Text>
        <Tool
          testID="tool-llm"
          icon="hardware-chip-outline"
          title="Modello AI & Budget LLM"
          desc="Scegli il modello (Gemini, Claude, GPT) e monitora la spesa stimata + ricarica."
          onPress={() => router.push("/llm-settings")}
        />

        <Text style={styles.section}>ANALISI</Text>
        <Tool
          testID="tool-book"
          icon="book-outline"
          title="Book Linee Guida"
          desc="Regole di selezione mercati e logiche di pronostico."
          onPress={() => router.push("/book")}
        />
        <Tool
          testID="tool-multipla"
          icon="flash-outline"
          title="Genera Multipla"
          desc="Scegli partite e quota totale: il motore seleziona le giocate più probabili del giorno, campionati a scalare, e le mette in Schedina."
          onPress={() => router.push("/multipla")}
        />
        <Tool
          testID="tool-ai-multipla"
          icon="sparkles-outline"
          title="Multipla via TypingMind (esterna)"
          desc="Cerca le partite di oggi sul web e propone una multipla da quota 13. Non usa la Schedina."
          onPress={openAIMultipla}
        />
        <Tool
          testID="tool-aistudio"
          icon="planet-outline"
          title="Framework TypingMind"
          desc="Genera CSV partite e copia framework prompt per analisi web esterna."
          onPress={openAIStudio}
        />
        <Tool
          testID="tool-selected"
          icon="albums-outline"
          title="Partite Selezionate"
          desc="Vedi e gestisci le partite selezionate."
          onPress={() => router.push("/selected")}
        />

        <Tool
          testID="tool-stats"
          icon="analytics-outline"
          title="Machine Learning Stats"
          desc="Vedi cosa ha imparato il sistema dai tuoi risultati e azzera l'apprendimento."
          onPress={() => router.push("/stats")}
        />

        {showApkInstall && (
          <>
            <Text style={styles.section}>APP ANDROID</Text>
            <Tool
              testID="tool-install-apk"
              icon="logo-android"
              title={isAndroidBrowser() ? "Installa App Android" : "App Android (APK)"}
              desc={isAndroidBrowser()
                ? "Scarica l'APK di PronoBlast. Si aggiorna da solo a ogni modifica, come GymBuilder."
                : "Apri la pagina dell'ultima versione dell'APK da installare sul telefono."}
              onPress={() => (isAndroidBrowser() ? downloadLatestApk() : openExternalUrl(RELEASE_LATEST_PAGE))}
            />
          </>
        )}

        <Text style={styles.section}>PERICOLO</Text>
        <Tool
          testID="tool-delete-all"
          icon="trash-outline"
          title="Svuota Database"
          desc="Elimina tutte le partite. Operazione irreversibile."
          onPress={deleteAll}
          danger
        />

        <View style={{ height: 40 }} />
      </ScrollView>

      {busy && (
        <View style={styles.busy}>
          <ActivityIndicator color={colors.primary} size="large" />
          <Text style={styles.busyTxt}>Elaborazione…</Text>
        </View>
      )}

      <BottomNav />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { color: colors.text, fontSize: 26, fontWeight: "900", letterSpacing: -0.5 },
  subtitle: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
  // La BottomNav sta NEL FLUSSO in fondo alla schermata: lo spazio se lo prende
  // da sola, quindi qui basta un margine di respiro. I 130px precedenti erano
  // pensati per una barra flottante e lasciavano un buco in fondo a ogni lista.
  list: { padding: 16, paddingBottom: 24, gap: 10 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  section: { color: colors.primary, fontSize: 11, fontWeight: "900", letterSpacing: 1.5, marginTop: 12, marginBottom: 4 },
  tool: {
    flex: 1, minWidth: 280,
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: 14, padding: 14,
  },
  toolDanger: { borderColor: "rgba(239,68,68,0.3)" },
  toolIcon: {
    width: 44, height: 44, borderRadius: 10,
    backgroundColor: "rgba(255,87,34,0.12)",
    alignItems: "center", justifyContent: "center",
  },
  toolTitle: { color: colors.text, fontSize: 14, fontWeight: "800" },
  toolDesc: { color: colors.textMuted, fontSize: 11, marginTop: 2, lineHeight: 15 },
  busy: { position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center", gap: 10 },
  busyTxt: { color: colors.text, fontWeight: "700" },
});

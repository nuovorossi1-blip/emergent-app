import React, { useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert, Platform, useWindowDimensions,
} from "react-native";
import { useBottomNav } from "@/src/components/BottomNavContext";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system/legacy";
import * as Linking from "expo-linking";
import * as Clipboard from "expo-clipboard";

import { api } from "@/src/api";
import { colors } from "@/src/theme";
import BottomNav from "@/src/components/BottomNav";
import { AISTUDIO_FRAMEWORK } from "@/src/book-content";
import { openExternalUrl, confirmAction } from "@/src/utils/platform";

export default function Strumenti() {
  const bottomNav = useBottomNav();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const isGrid = width >= 600; // tablet/desktop → grid 2-col
  const [busy, setBusy] = useState<string | null>(null);

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
      if (skippedCount > 0) {
        if (Platform.OS === "web") {
          // window.confirm fallback
          const go = (typeof window !== "undefined" && window.confirm)
            ? window.confirm(`Import completato\n\n${lines.join("\n")}\n\nVuoi vedere i dettagli degli scarti?`)
            : false;
          if (go) router.push("/scartati");
        } else {
          Alert.alert(
            "Import completato",
            lines.join("\n"),
            [
              { text: "Chiudi", style: "cancel" },
              { text: "Vedi Scarti", onPress: () => router.push("/scartati") },
            ],
          );
        }
      } else {
        Alert.alert("Import completato", lines.join("\n"));
      }
    } catch (e: any) {
      Alert.alert("Errore Import", e?.message || "Errore parser");
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
        Alert.alert("Esportato", "Download completato");
      } else {
        const path = `${FileSystem.cacheDirectory}${name}`;
        await FileSystem.writeAsStringAsync(path, json);
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(path, { mimeType: "application/json" });
        } else {
          Alert.alert("Salvato", path);
        }
      }
    } catch (e: any) {
      Alert.alert("Errore Export", e?.message);
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
      Alert.alert(
        "Import Backup",
        `Partite importate: ${out.inserted_matches}\nDuplicati saltati: ${out.skipped_matches}\nPronostici: ${out.inserted_predictions}`,
      );
    } catch (e: any) {
      Alert.alert("Errore", e?.message);
    } finally {
      setBusy(null);
    }
  };

  const openAIStudio = async () => {
    setBusy("aistudio");
    try {
      const { csv, count } = await api.aiStudioPrompt();
      if (count === 0) {
        Alert.alert("Nessuna partita selezionata", "Seleziona almeno una partita per usare il framework AI Studio.");
        return;
      }
      const filled = AISTUDIO_FRAMEWORK.replace("{{CSV}}", csv);
      // CRITICAL: open the new tab BEFORE any async call (popup blocker)
      let newWin: Window | null = null;
      if (Platform.OS === "web" && typeof window !== "undefined") {
        newWin = window.open("https://aistudio.google.com/prompts/new_chat", "_blank", "noopener,noreferrer");
      }
      try {
        await Clipboard.setStringAsync(filled);
      } catch {
        if (Platform.OS === "web" && typeof navigator !== "undefined") {
          try { await (navigator as any).clipboard.writeText(filled); } catch {}
        }
      }
      if (Platform.OS !== "web") {
        openExternalUrl("https://aistudio.google.com/prompts/new_chat");
      }
      if (Platform.OS === "web" && !newWin) {
        Alert.alert("Popup bloccato", "Abilita i popup per questo sito o apri manualmente https://aistudio.google.com/prompts/new_chat e incolla con Ctrl+V.");
        return;
      }
      Alert.alert("Prompt Copiato ✓", `${count} partite. Incolla con Ctrl+V nella nuova scheda di AI Studio.`);
    } catch (e: any) {
      Alert.alert("Errore", e?.message);
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
        Alert.alert("Fatto", "Database svuotato");
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
          testID="tool-aistudio"
          icon="planet-outline"
          title="Framework Google AI Studio"
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
  list: { padding: 16, paddingBottom: 130, gap: 10 },
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

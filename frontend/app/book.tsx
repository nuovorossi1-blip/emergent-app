import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Linking, Alert, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import BottomNav from "@/src/components/BottomNav";
import { colors } from "@/src/theme";
import { BOOK_RULES, AISTUDIO_FRAMEWORK } from "@/src/book-content";
import { api } from "@/src/api";

export default function Book() {
  const router = useRouter();
  const [open, setOpen] = useState<Set<string>>(new Set());

  const toggle = (k: string) => {
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k); else n.add(k);
      return n;
    });
  };

  const openAIStudio = async () => {
    try {
      const { csv } = await api.aiStudioPrompt();
      const filled = AISTUDIO_FRAMEWORK.replace("{{CSV}}", csv);
      if (Platform.OS === "web") {
        try { await (navigator as any).clipboard.writeText(filled); } catch {}
      }
      Alert.alert(
        "Apri AI Studio",
        "Il prompt con CSV è pronto. Apri Google AI Studio e incolla.",
        [
          { text: "Annulla", style: "cancel" },
          { text: "Apri", onPress: () => Linking.openURL("https://aistudio.google.com/prompts/new_chat") },
        ],
      );
    } catch (e: any) {
      Alert.alert("Errore", e?.message);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Book Pronostici</Text>
          <Text style={styles.subtitle}>Linee guida per la selezione dei mercati</Text>
        </View>
        <TouchableOpacity
          testID="close-book"
          onPress={() => router.replace("/")}
          style={styles.closeBtn}
        >
          <Ionicons name="close" size={22} color={colors.text} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.list}>
        <TouchableOpacity
          testID="open-ai-studio"
          onPress={openAIStudio}
          style={styles.aiCard}
          activeOpacity={0.85}
        >
          <Ionicons name="planet" size={22} color={colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.aiCardTitle}>Apri Framework su AI Studio</Text>
            <Text style={styles.aiCardDesc}>Prompt PARTITA_WEB + PARTITA_LLM con CSV partite</Text>
          </View>
          <Ionicons name="open-outline" size={18} color={colors.textMuted} />
        </TouchableOpacity>

        <Text style={styles.section}>REGOLE PER MERCATO</Text>

        {BOOK_RULES.map((r) => {
          const isOpen = open.has(r.market);
          return (
            <View key={r.market} style={styles.rule}>
              <TouchableOpacity
                testID={`book-rule-${r.market}`}
                onPress={() => toggle(r.market)}
                style={styles.ruleHeader}
                activeOpacity={0.7}
              >
                <View style={styles.ruleBadge}>
                  <Text style={styles.ruleBadgeTxt}>{r.market}</Text>
                </View>
                <Text style={styles.ruleTitle}>{r.title}</Text>
                <Ionicons name={isOpen ? "chevron-up" : "chevron-down"} size={18} color={colors.textMuted} />
              </TouchableOpacity>
              {isOpen && (
                <View style={styles.ruleBody}>
                  {r.rules.map((line, i) => (
                    <View key={i} style={styles.bullet}>
                      <Text style={styles.bulletDot}>•</Text>
                      <Text style={styles.bulletTxt}>{line}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          );
        })}
        <View style={{ height: 40 }} />
      </ScrollView>

      <BottomNav />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { color: colors.text, fontSize: 24, fontWeight: "900", letterSpacing: -0.5 },
  subtitle: { color: colors.textMuted, fontSize: 12, marginTop: 4 },
  closeBtn: { padding: 8, backgroundColor: colors.surface, borderRadius: 999, borderWidth: 1, borderColor: colors.border },
  list: { padding: 16, gap: 10 },
  aiCard: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.primary,
    borderRadius: 14, padding: 14,
  },
  aiCardTitle: { color: colors.text, fontSize: 14, fontWeight: "800" },
  aiCardDesc: { color: colors.textMuted, fontSize: 11, marginTop: 2 },
  section: { color: colors.primary, fontSize: 11, fontWeight: "900", letterSpacing: 1.5, marginTop: 8 },
  rule: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: "hidden" },
  ruleHeader: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12 },
  ruleBadge: { backgroundColor: colors.primary, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, minWidth: 48, alignItems: "center" },
  ruleBadgeTxt: { color: "#FFF", fontWeight: "900", fontSize: 11, letterSpacing: 0.5 },
  ruleTitle: { color: colors.text, fontSize: 13, fontWeight: "800", flex: 1 },
  ruleBody: { paddingHorizontal: 14, paddingBottom: 14, gap: 6, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 },
  bullet: { flexDirection: "row", gap: 8 },
  bulletDot: { color: colors.primary, fontWeight: "900", fontSize: 14, lineHeight: 18 },
  bulletTxt: { color: colors.text, fontSize: 12, flex: 1, lineHeight: 18 },
});

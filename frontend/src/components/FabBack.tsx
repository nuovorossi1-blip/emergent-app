/**
 * FAB BACK MINIMALE
 * =================
 * Floating Action Button discreto in basso a destra che torna alla schermata
 * precedente. Si nasconde automaticamente sulle route hub (/, /selected, /profilo,
 * /strumenti, /book) dove non ha senso "tornare indietro".
 *
 * Posizionato SOPRA la BottomNav (insets.bottom + nav height + 16px).
 */
import React from "react";
import { TouchableOpacity, StyleSheet, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "@/src/theme";

const HUB_ROUTES = ["/", "/selected", "/profilo", "/strumenti", "/book"];

export default function FabBack() {
  const router = useRouter();
  const path = usePathname();
  const insets = useSafeAreaInsets();

  // Nascondi sulle route hub (non c'è davvero un "indietro")
  if (HUB_ROUTES.includes(path)) return null;

  // Posizione: sopra la BottomNav (≈ insets.bottom + 56 nav + 12 margin)
  const bottomOffset = insets.bottom + 56 + 80;

  return (
    <TouchableOpacity
      onPress={() => {
        if (router.canGoBack()) router.back();
        else router.replace("/");
      }}
      style={[styles.fab, { bottom: bottomOffset }]}
      activeOpacity={0.7}
      accessibilityLabel="Torna indietro"
    >
      <Ionicons name="chevron-back" size={20} color={colors.text} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: "absolute",
    right: 14,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "rgba(20,20,20,0.92)",
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
      android: { elevation: 6 },
      default: {},
    }),
    zIndex: 50,
  },
});

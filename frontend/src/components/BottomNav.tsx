import React, { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { useAnimatedStyle, interpolate } from "react-native-reanimated";
import { colors } from "@/src/theme";
import { api } from "@/src/api";
import { useBottomNav } from "@/src/components/BottomNavContext";
import { selectedListCache } from "@/src/utils/cache";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

const TABS: { route: string; label: string; icon: IconName; testID: string }[] = [
  { route: "/profilo", label: "Profilo", icon: "person-circle-outline", testID: "tab-profile" },
  { route: "/strumenti", label: "Strumenti", icon: "construct-outline", testID: "tab-tools" },
  { route: "/", label: "Partite", icon: "trophy-outline", testID: "tab-home" },
  { route: "/selected", label: "Schedina", icon: "ticket-outline", testID: "tab-schedina" },
  { route: "/book", label: "Book", icon: "book-outline", testID: "tab-book" },
];

export default function BottomNav() {
  const router = useRouter();
  const path = usePathname();
  const insets = useSafeAreaInsets();
  const { visible, show } = useBottomNav();
  const [selCount, setSelCount] = useState(0);

  // Ogni cambio rotta → forza la BottomNav visibile + aggiorna selCount via cache
  useEffect(() => {
    show();
    const cached = selectedListCache.get();
    if (cached) setSelCount(cached.length);
    if (selectedListCache.isStale()) {
      let active = true;
      api.selectedList().then(list => {
        if (active) { selectedListCache.set(list); setSelCount(list.length); }
      }).catch(() => {});
      return () => { active = false; };
    }
  }, [path, show]);

  // ============================================================
  // Padding bottom: usa SOLO insets reali (la Android nav bar è
  // ora SEMPRE visibile via _layout.tsx con behavior="inset-swipe").
  // Quindi insets.bottom restituisce il valore corretto su tutte
  // le piattaforme:
  //  - Android 3-button: ~48dp
  //  - Android gesture: ~24dp
  //  - iOS home-indicator: ~34dp
  //  - iOS no notch: 0dp
  //  - Web: 0dp
  // Aggiungiamo 12dp di respiro interno fisso.
  // ============================================================
  const bottomPadding = insets.bottom + 12;
  const navHeight = bottomPadding + 56; // 56 ≈ altezza contenuto tab + paddingTop

  // ============================================================
  // Auto-hide: si nasconde quando l'utente scorre verso il basso
  // attraverso il contenuto (scroll-down attivo). Riappare allo
  // scroll-up. Animazione translateY 0 → navHeight.
  // I tasti di sistema Android restano comunque sempre visibili
  // (sono fuori dal nostro spazio app).
  // ============================================================
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: interpolate(visible.value, [0, 1], [navHeight, 0]) }],
    opacity: interpolate(visible.value, [0, 1], [0, 1]),
  }));

  return (
    <Animated.View style={[styles.wrap, { paddingBottom: bottomPadding }, animStyle]}>
      {TABS.map((t) => {
        const active = (t.route === "/" && path === "/") || (t.route !== "/" && path?.startsWith(t.route));
        const isSchedina = t.route === "/selected";
        return (
          <TouchableOpacity
            key={t.route}
            testID={t.testID}
            onPress={() => router.replace(t.route as any)}
            style={styles.tab}
            activeOpacity={0.6}
            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
          >
            <View>
              <Ionicons name={t.icon} size={22} color={active ? colors.primary : colors.textMuted} />
              {isSchedina && selCount > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeTxt}>{selCount > 99 ? "99+" : selCount}</Text>
                </View>
              )}
            </View>
            <Text style={[styles.label, { color: active ? colors.primary : colors.textMuted }]}>
              {t.label}{isSchedina && selCount > 0 ? ` (${selCount})` : ""}
            </Text>
          </TouchableOpacity>
        );
      })}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    backgroundColor: "rgba(10,10,10,0.96)",
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 8,
    paddingHorizontal: 4,
  },
  tab: { flex: 1, alignItems: "center", justifyContent: "center", gap: 4 },
  label: { fontSize: 10, fontWeight: "800", letterSpacing: 0.5, textTransform: "uppercase" },
  badge: {
    position: "absolute", top: -4, right: -8,
    minWidth: 16, height: 16, paddingHorizontal: 4, borderRadius: 8,
    backgroundColor: colors.primary, alignItems: "center", justifyContent: "center",
    borderWidth: 1.5, borderColor: colors.bg,
  },
  badgeTxt: { color: "#FFF", fontSize: 9, fontWeight: "900" },
});

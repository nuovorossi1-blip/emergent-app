import React, { createContext, useContext, useState, useCallback, useRef } from "react";
import { Text, StyleSheet, Platform } from "react-native";
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "@/src/theme";

/**
 * Toast cross-platform leggero. Mostra messaggi temporanei in alto.
 * - Auto-dismiss dopo 2.5s
 * - Animazione fade + slide-down
 * - 3 varianti: success / info / error
 */
type ToastType = "success" | "info" | "error";

type ToastCtx = {
  show: (message: string, type?: ToastType) => void;
};

const Ctx = createContext<ToastCtx | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const [msg, setMsg] = useState<string>("");
  const [type, setType] = useState<ToastType>("info");
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(-20);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = useCallback(() => {
    opacity.value = withTiming(0, { duration: 180 });
    translateY.value = withTiming(-20, { duration: 180 });
  }, [opacity, translateY]);

  const show = useCallback((message: string, t: ToastType = "info") => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setMsg(message);
    setType(t);
    opacity.value = withTiming(1, { duration: 200 });
    translateY.value = withTiming(0, { duration: 200 });
    hideTimer.current = setTimeout(() => hide(), 2200);
  }, [hide, opacity, translateY]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  const iconMap: Record<ToastType, { name: any; color: string; bg: string }> = {
    success: { name: "checkmark-circle", color: colors.success, bg: "rgba(16,185,129,0.18)" },
    info: { name: "information-circle", color: colors.primary, bg: "rgba(245,158,11,0.18)" },
    error: { name: "close-circle", color: colors.danger, bg: "rgba(239,68,68,0.18)" },
  };
  const icon = iconMap[type];

  const topOffset = Math.max(insets.top, 8) + 8;

  return (
    <Ctx.Provider value={{ show }}>
      {children}
      {msg ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.wrap,
            { top: topOffset, backgroundColor: icon.bg, borderColor: icon.color },
            animStyle,
          ]}
        >
          <Ionicons name={icon.name} size={18} color={icon.color} />
          <Text style={[styles.txt, { color: icon.color }]} numberOfLines={2}>{msg}</Text>
        </Animated.View>
      ) : null}
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) return { show: (_: string, __?: ToastType) => {} };
  return ctx;
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 16,
    right: 16,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    zIndex: 9999,
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.2, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
      android: { elevation: 8 },
      default: {},
    }),
    backdropFilter: "blur(8px)" as any,
  },
  txt: { flex: 1, fontSize: 13, fontWeight: "700" },
});

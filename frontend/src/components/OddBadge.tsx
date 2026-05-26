import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { colors } from "@/src/theme";

export function OddBadge({
  label,
  value,
  estimated,
  size = "md",
}: {
  label: string;
  value: number | null | undefined;
  estimated?: boolean;
  size?: "sm" | "md";
}) {
  if (value == null) {
    return (
      <View style={[styles.empty, size === "sm" && styles.smPad]}>
        <Text style={styles.emptyLabel}>{label}</Text>
        <Text style={styles.emptyVal}>—</Text>
      </View>
    );
  }
  return (
    <LinearGradient
      colors={[colors.primaryLight, colors.primaryDark]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.badge, size === "sm" && styles.smPad]}
    >
      <Text style={styles.bLabel}>{label}</Text>
      <Text style={styles.bValue}>{value.toFixed(2)}</Text>
      {estimated && <Text style={styles.bEst}>stima</Text>}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    minWidth: 64,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
  },
  smPad: { paddingHorizontal: 6, paddingVertical: 4, minWidth: 48 },
  bLabel: { color: "#FFF", fontSize: 10, fontWeight: "800", letterSpacing: 0.6, opacity: 0.9 },
  bValue: { color: "#FFF", fontSize: 16, fontWeight: "900", marginTop: 1 },
  bEst: { color: "#FFE4D9", fontSize: 8, fontWeight: "700", marginTop: 1 },
  empty: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    minWidth: 64,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceHi,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyLabel: { color: colors.textMuted, fontSize: 10, fontWeight: "700" },
  emptyVal: { color: colors.textDim, fontSize: 16, fontWeight: "900" },
});

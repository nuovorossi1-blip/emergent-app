import React, { createContext, useContext, useRef, useCallback } from "react";
import { useSharedValue, withTiming, SharedValue } from "react-native-reanimated";

type BottomNavCtx = {
  visible: SharedValue<number>; // 1 = visible, 0 = hidden
  handleScroll: (currentY: number) => void;
  show: () => void;
};

const Ctx = createContext<BottomNavCtx | null>(null);

export function BottomNavProvider({ children }: { children: React.ReactNode }) {
  const visible = useSharedValue(1);
  const lastY = useRef(0);
  const cumulative = useRef(0);
  const THRESHOLD = 12; // px di scroll continuo prima di triggerare

  const handleScroll = useCallback((currentY: number) => {
    const dy = currentY - lastY.current;
    lastY.current = currentY;

    if (currentY < 30) {
      // top page → sempre visibile
      cumulative.current = 0;
      if (visible.value !== 1) visible.value = withTiming(1, { duration: 200 });
      return;
    }

    if (dy > 0) {
      // scroll DOWN (contenuto si muove verso l'alto)
      cumulative.current = Math.max(0, cumulative.current) + dy;
      if (cumulative.current > THRESHOLD && visible.value !== 0) {
        visible.value = withTiming(0, { duration: 200 });
        cumulative.current = 0;
      }
    } else if (dy < 0) {
      // scroll UP (utente torna indietro)
      cumulative.current = Math.min(0, cumulative.current) + dy;
      if (cumulative.current < -THRESHOLD && visible.value !== 1) {
        visible.value = withTiming(1, { duration: 200 });
        cumulative.current = 0;
      }
    }
  }, [visible]);

  const show = useCallback(() => {
    cumulative.current = 0;
    lastY.current = 0;
    visible.value = withTiming(1, { duration: 200 });
  }, [visible]);

  return <Ctx.Provider value={{ visible, handleScroll, show }}>{children}</Ctx.Provider>;
}

export function useBottomNav() {
  const ctx = useContext(Ctx);
  if (!ctx) {
    // fallback no-op (in caso di pagine fuori provider)
    const dummy = useSharedValue(1);
    return { visible: dummy, handleScroll: () => {}, show: () => {} };
  }
  return ctx;
}

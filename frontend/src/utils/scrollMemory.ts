/**
 * SESSION SCROLL CACHE
 * ====================
 * Memorizza in memoria la posizione di scroll di ogni route.
 * Permette di tornare allo stesso punto quando si naviga tra schermate.
 * Si resetta a chiusura app (in-memory, no AsyncStorage).
 *
 * Usage:
 *   const scrollRef = useScrollMemory('/match/123');
 *   <ScrollView ref={scrollRef.ref} onScroll={scrollRef.onScroll} ...>
 */
import { useRef, useCallback, useEffect } from "react";
import type { ScrollView, NativeSyntheticEvent, NativeScrollEvent } from "react-native";

const scrollMap = new Map<string, number>();

export function rememberScroll(key: string, y: number) {
  scrollMap.set(key, y);
}

export function getRememberedScroll(key: string): number {
  return scrollMap.get(key) || 0;
}

export function clearScrollMemory(key?: string) {
  if (key) scrollMap.delete(key);
  else scrollMap.clear();
}

/**
 * Hook React per ricordare la posizione di scroll di una pagina.
 * Restituisce {ref, onScroll} da applicare alla ScrollView.
 * Al mount ripristina lo scroll. Su scroll lo aggiorna in memoria.
 */
export function useScrollMemory(routeKey: string) {
  const ref = useRef<ScrollView | null>(null);

  // Restore scroll position al mount (delay 50ms per dare tempo al rendering)
  useEffect(() => {
    const y = getRememberedScroll(routeKey);
    if (y > 0 && ref.current) {
      const t = setTimeout(() => {
        ref.current?.scrollTo({ y, animated: false });
      }, 50);
      return () => clearTimeout(t);
    }
  }, [routeKey]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    rememberScroll(routeKey, e.nativeEvent.contentOffset.y);
  }, [routeKey]);

  return { ref, onScroll, scrollEventThrottle: 100 };
}

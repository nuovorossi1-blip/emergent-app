/**
 * Module-level prediction queue.
 * Tracks which match IDs are currently awaiting an AI prediction so the UI
 * can keep them "in progress" even when the user navigates away.
 *
 * When the user clicks "Genera Pronostico AI", the call is fired and
 * registered here. Subscribers (any component that wants to display a spinner
 * on those matches) call `subscribe()` to get notified on changes.
 */

import { api } from "@/src/api";

type Listener = () => void;

const pending = new Set<string>();
const listeners = new Set<Listener>();

function notify() {
  for (const l of listeners) {
    try { l(); } catch {}
  }
}

export const predictionQueue = {
  /**
   * Add a match ID to the in-flight queue and start the prediction in background.
   * Returns the promise so callers can optionally await it.
   */
  enqueue(matchId: string, forceRegen: boolean = false): Promise<any> {
    pending.add(matchId);
    notify();
    return api.predict(matchId, forceRegen)
      .catch((e) => {
        // Surface error via a one-shot listener? For now, just log.
        console.warn("Background prediction failed for", matchId, e);
        return null;
      })
      .finally(() => {
        pending.delete(matchId);
        notify();
      });
  },

  isPending(matchId: string): boolean {
    return pending.has(matchId);
  },

  size(): number {
    return pending.size;
  },

  pendingIds(): string[] {
    return Array.from(pending);
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

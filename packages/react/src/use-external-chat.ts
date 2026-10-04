"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { ChatController } from "./components.js";
import type { ChatState } from "./types.js";

/** An application-owned store. Snapshot identity must remain stable until it changes. */
export interface ExternalChatStore<TSnapshot> {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => TSnapshot;
  getServerSnapshot?: () => TSnapshot;
}

export interface UseExternalChatOptions<TSnapshot> {
  store: ExternalChatStore<TSnapshot>;
  /** Pure presentation projection; do not start work or mutate the snapshot here. */
  selectState: (snapshot: TSnapshot) => ChatState;
  actions: Omit<ChatController, "state">;
}

/** Subscribe to a durable host without creating a transport, reducer, or agent runtime. */
export function useExternalChat<TSnapshot>({
  store, selectState, actions
}: UseExternalChatOptions<TSnapshot>): { controller: ChatController; snapshot: TSnapshot } {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const state = useMemo(() => selectState(snapshot), [selectState, snapshot]);
  return { controller: { ...actions, state }, snapshot };
}

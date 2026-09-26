"use client";
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { createIdentityClient } from "../lib/identity/client";
import type { IdentityClient } from "../lib/identity/contracts";
import { IdentityStore } from "../lib/identity/store";
const Context = createContext<IdentityStore | null>(null);
export function IdentityProvider({ children, client, clock }: { children: ReactNode; client?: IdentityClient; clock?: () => number }) {
  const store = useMemo(() => new IdentityStore(client ?? createIdentityClient(), clock), [client, clock]);
  useEffect(() => {
    void store.refresh();
    const timer = setInterval(store.tick, 1000);
    const revalidate = () => { store.tick(); void store.refresh(); };
    const visible = () => { if (document.visibilityState === "visible") revalidate(); };
    window.addEventListener("focus", revalidate); document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); window.removeEventListener("focus", revalidate); document.removeEventListener("visibilitychange", visible); store.dispose(); };
  }, [store]);
  return <Context value={store}>{children}</Context>;
}
export function useIdentity() {
  const store = useContext(Context);
  if (!store) throw new Error("Identity provider required");
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  return { ...snapshot, store, integrated: store.client.integrated };
}

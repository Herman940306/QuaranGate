"use client";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createOperationalClient, type OperationalClient } from "../lib/operational/client";
import type { OperationalState } from "../lib/operational/state";
interface Connection { client: OperationalClient; state: OperationalState; report: (state: OperationalState) => void }
const Context = createContext<Connection | null>(null);
export function OperationalProvider({ children, client: injected }: { children: ReactNode; client?: OperationalClient }) {
  const client = useMemo(() => injected ?? createOperationalClient(), [injected]);
  const [state, report] = useState<OperationalState>("not_connected");
  return <Context value={{ client, state, report }}>{children}</Context>;
}
export function useOperational() { const context = useContext(Context); if (!context) throw new Error("Operational provider required"); return context; }

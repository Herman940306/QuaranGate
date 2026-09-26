"use client";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createOperationalClient, type OperationalClient } from "../lib/operational/client";
import type { OperationalState } from "../lib/operational/state";
interface Connection { client: OperationalClient; state: OperationalState; report: (state: OperationalState) => void; projectionEpoch: number }
const Context = createContext<Connection | null>(null);
export function OperationalProvider({ children, client: injected, projectionEpoch = 0 }: { children: ReactNode; client?: OperationalClient; projectionEpoch?: number }) {
  const client = useMemo(() => injected ?? createOperationalClient(), [injected]);
  const [connection, setConnection] = useState<{ state: OperationalState; epoch: number }>({ state: "not_connected", epoch: projectionEpoch });
  const state = connection.epoch === projectionEpoch ? connection.state : "not_connected";
  const report = (next: OperationalState) => setConnection({ state: next, epoch: projectionEpoch });
  return <Context value={{ client, state, report, projectionEpoch }}>{children}</Context>;
}
export function useOperational() { const context = useContext(Context); if (!context) throw new Error("Operational provider required"); return context; }

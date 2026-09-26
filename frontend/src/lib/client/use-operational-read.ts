"use client";
import { useEffect, useRef, useState } from "react";
import { useOperational } from "../../components/operational-provider";
import { OperationalError, type OperationalState } from "../operational/state";
import type { ReadReceipt } from "../operational/transport";
export function useOperationalRead<T>() {
  const { report } = useOperational();
  const [receipt, setReceipt] = useState<ReadReceipt<T>>();
  const [state, setState] = useState<OperationalState>("not_connected");
  const [correlationId, setCorrelation] = useState<string>();
  const [pending, setPending] = useState(false);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  async function run(operation: (signal: AbortSignal) => Promise<ReadReceipt<T>>) {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setPending(true); setReceipt(undefined); setCorrelation(undefined);
    try {
      const next = await operation(controller.signal);
      if (active.current !== controller || controller.signal.aborted) return;
      setReceipt(next); setCorrelation(next.correlationId); setState("available"); report("available");
    } catch (error) {
      if (active.current !== controller) return;
      const failure = error instanceof OperationalError ? error : new OperationalError("unknown");
      setState(failure.state); setCorrelation(failure.correlationId);
      if (failure.state !== "cancelled") report(failure.state);
    } finally { if (active.current === controller) { active.current = null; setPending(false); } }
  }
  function cancel() { active.current?.abort(); active.current = null; setPending(false); setState("cancelled"); }
  return { run, cancel, receipt, state, pending, correlationId };
}

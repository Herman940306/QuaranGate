"use client";
import { useEffect, useRef, useState } from "react";
import { useOperational } from "../../../components/operational-provider";
import { OperationalError, type OperationalState } from "../../operational/state";
import type { ReadReceipt } from "../../operational/transport";

export function useWorkstationAction<T>() {
  const { projectionEpoch } = useOperational();
  const epoch = useRef(projectionEpoch); epoch.current = projectionEpoch;
  const running = useRef(false);
  const [view, setView] = useState<{ epoch: number; pending: boolean; receipt?: ReadReceipt<T>; failure?: OperationalState; check?: "pending" | "confirmed" | "unavailable" }>({ epoch: projectionEpoch, pending: false });
  useEffect(() => { setView({ epoch: projectionEpoch, pending: false }); return () => { running.current = false; }; }, [projectionEpoch]);
  async function run(action: () => Promise<ReadReceipt<T>>, reconcile?: () => Promise<unknown>): Promise<boolean> {
    if (running.current) return false;
    running.current = true;
    const requestEpoch = projectionEpoch;
    setView({ epoch: requestEpoch, pending: true });
    try {
      const receipt = await action();
      if (epoch.current !== requestEpoch) return false;
      setView({ epoch: requestEpoch, pending: false, receipt, check: reconcile ? "pending" : undefined });
      if (reconcile) {
        try { await reconcile(); if (epoch.current === requestEpoch) setView({ epoch: requestEpoch, pending: false, receipt, check: "confirmed" }); }
        catch { if (epoch.current === requestEpoch) setView({ epoch: requestEpoch, pending: false, receipt, check: "unavailable" }); }
      }
      return true;
    } catch (error) {
      if (epoch.current === requestEpoch) setView({ epoch: requestEpoch, pending: false, failure: error instanceof OperationalError ? error.state : "unknown" });
      return false;
    } finally { running.current = false; }
  }
  function reset() { if (!running.current) setView({ epoch: projectionEpoch, pending: false }); }
  return { run, reset, pending: view.epoch === projectionEpoch && view.pending, receipt: view.epoch === projectionEpoch ? view.receipt : undefined, failure: view.epoch === projectionEpoch ? view.failure : undefined, check: view.epoch === projectionEpoch ? view.check : undefined };
}

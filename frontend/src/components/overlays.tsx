"use client";
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { transitionFor } from "../lib/motion";
import { Button } from "./primitives";

type Overlay = { title: string; description: string; children: ReactNode; kind?: "dialog" | "drawer"; closeOnDesktop?: boolean };
type OverlayApi = { open: (overlay: Overlay) => void; close: () => void; notify: (message: string) => void };
const OverlayContext = createContext<OverlayApi | null>(null);
export function useOverlay() {
  const value = useContext(OverlayContext);
  if (!value) throw new Error("OverlayProvider is required");
  return value;
}
export function OverlayProvider({ children }: { children: ReactNode }) {
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [message, setMessage] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const reduced = useReducedMotion();
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!overlay || !element) return;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    element.querySelector<HTMLButtonElement>("[data-close]")?.focus();
    return () => {
      element.close();
      document.body.style.overflow = oldOverflow;
      if (trigger.current?.isConnected) trigger.current.focus();
    };
  }, [overlay]);
  useEffect(() => {
    if (!overlay?.closeOnDesktop) return;
    const query = window.matchMedia("(min-width: 880px)");
    let wasDesktop = query.matches;
    function onBreakpoint(event: MediaQueryListEvent) {
      // Only the navigation drawer belongs to the responsive rail transition.
      // Ignore redundant events, including full-page screenshot viewport probes.
      if (!wasDesktop && event.matches) setOverlay(null);
      wasDesktop = event.matches;
    }
    query.addEventListener("change", onBreakpoint);
    return () => query.removeEventListener("change", onBreakpoint);
  }, [overlay]);
  function close() { setOverlay(null); }
  function open(value: Overlay) {
    // One modal owner: never replace an active focus trap with a nested modal.
    if (overlay) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOverlay(value);
  }
  return <OverlayContext.Provider value={{ open, close, notify: setMessage }}>
    {children}
    <div className="toast-center"><div role="status" aria-live="polite" aria-atomic="true">{message ? <p className="toast">{message}</p> : null}</div>{message ? <Button onClick={() => setMessage("")} aria-label="Dismiss notification" emphasis="ghost">Dismiss</Button> : null}</div>
    {overlay ? <dialog ref={dialog} className="modal" data-kind={overlay.kind ?? "dialog"} aria-labelledby={titleId} aria-describedby={descriptionId} onCancel={e => { e.preventDefault(); close(); }} onKeyDown={event => {
      if (event.key !== "Tab") return;
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(item => item.getClientRects().length);
      const first = items[0]; const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <motion.div initial={reduced ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={transitionFor("panel", Boolean(reduced))}>
        <div className="modal-header"><h2 id={titleId}>{overlay.title}</h2><Button data-close onClick={close}>Close</Button></div>
        <p id={descriptionId} className="muted">{overlay.description}</p>
        <div className="modal-content">{overlay.children}</div>
      </motion.div>
    </dialog> : null}
  </OverlayContext.Provider>;
}

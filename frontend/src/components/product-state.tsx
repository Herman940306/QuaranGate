"use client";
import { useEffect, useRef, useState } from "react";
import { productCopy, type Result } from "../lib/client/product/contracts";
import { ProductRequest } from "../lib/client/product/request";
import { Button } from "./primitives";
export function useProductRequest<T>() {
  const [result, setResult] = useState<Result<T> | { kind: "loading" }>({ kind: "integration_pending" });
  const request = useRef<ProductRequest | null>(null); if (!request.current) request.current = new ProductRequest();
  useEffect(() => () => request.current?.cancel(), []);
  function run(call: (s: AbortSignal) => Promise<Result<T>>) {
    if (request.current?.pending) return;
    setResult({ kind: "loading" });
    void request.current?.run(call, r => { setResult(r); });
  }
  function cancel() { request.current?.cancel(); setResult({ kind: "cancelled" }); }
  return { result, run, cancel, pending: result.kind === "loading" };
}
export function ProductFeedback({ kind }: { kind: Exclude<Result<unknown>["kind"], "available"> | "loading" }) { return <p role={kind === "loading" ? "status" : "alert"}>{productCopy[kind]}</p>; }
export function ProductCancel({ cancel }: { cancel: () => void }) { useEffect(() => { document.getElementById("product-cancel")?.focus(); }, []); return <Button id="product-cancel" onClick={cancel}>Cancel request</Button>; }

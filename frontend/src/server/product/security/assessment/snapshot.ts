import "server-only";
import { createHash } from "node:crypto";
import { ProductDataError } from "../../data/errors";
import type { ImmutableSnapshot } from "./types";

const MAX_SNAPSHOT_BYTES = 256 * 1024;
const SENSITIVE_KEY = /^(?:secret|secrets|token|tokens|password|passwords|credential|credentials|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)$/i;
const SENSITIVE_VALUE = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/;

function assertJsonSafe(value: unknown, path: string[] = []): void {
  if (value === null) return;

  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (Number.isFinite(value)) return;
      break;
    case "object": {
      if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) assertJsonSafe(item, [...path, String(index)]);
        return;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) break;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        assertJsonSafe(child, [...path, key]);
      }
      return;
    }
    default:
      break;
  }

  throw new ProductDataError(
    "PRODUCT_DATA_INVALID",
    `assessment_snapshot_non_json_value:${path.join(".") || "$"}`,
  );
}

function stable(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stable);
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    output[key] = stable((value as Record<string, unknown>)[key]);
  }
  return output;
}

function assertNoSensitiveMaterial(value: unknown, path: string[] = []): void {
  if (value === null) return;

  if (typeof value === "string") {
    if (SENSITIVE_VALUE.test(value)) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_snapshot_sensitive_value_denied");
    }
    if (path.some((part) => SENSITIVE_KEY.test(part)) && value.trim().length > 0) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_snapshot_sensitive_field_denied");
    }
    return;
  }

  if (typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoSensitiveMaterial(item, [...path, String(index)]);
    }
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      SENSITIVE_KEY.test(key)
      && child !== null
      && child !== false
      && child !== ""
    ) {
      throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_snapshot_sensitive_field_denied");
    }
    assertNoSensitiveMaterial(child, [...path, key]);
  }
}

export function canonicalSnapshot<T>(value: T): ImmutableSnapshot<T> {
  assertJsonSafe(value);
  assertNoSensitiveMaterial(value);
  const canonical = JSON.stringify(stable(value));
  const byteLength = Buffer.byteLength(canonical, "utf8");
  if (byteLength <= 0 || byteLength > MAX_SNAPSHOT_BYTES) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_snapshot_size_invalid");
  }
  return {
    schemaVersion: "BE9_SNAPSHOT_V1",
    algorithm: "sha256",
    digest: createHash("sha256").update(canonical).digest("hex"),
    value,
    byteLength,
  };
}

export function verifySnapshot(snapshot: ImmutableSnapshot<unknown>): void {
  const recomputed = canonicalSnapshot(snapshot.value);
  if (
    snapshot.schemaVersion !== "BE9_SNAPSHOT_V1"
    || snapshot.algorithm !== "sha256"
    || snapshot.digest !== recomputed.digest
    || snapshot.byteLength !== recomputed.byteLength
  ) {
    throw new ProductDataError("PRODUCT_DATA_INVALID", "assessment_snapshot_digest_mismatch");
  }
}

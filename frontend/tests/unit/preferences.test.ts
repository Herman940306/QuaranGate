import { expect, it } from "vitest";
import { createMemoryAppearanceAdapter, defaultAppearance } from "../../src/lib/appearance";
import { createPendingPreferenceSync } from "../../src/lib/product/preferences";
it("local preview is memory-only; future sync cannot claim successful persistence", async () => {
  const local = createMemoryAppearanceAdapter(); local.write({ ...defaultAppearance, mode: "dark" });
  expect(local.read().mode).toBe("dark"); expect(createMemoryAppearanceAdapter().read().mode).toBe("system");
  const sync = createPendingPreferenceSync(); const controller = new AbortController();
  expect(await sync.read("synthetic-session-version", controller.signal)).toEqual({ kind: "integration_pending" });
  expect(await sync.write(local.read(), "synthetic-preference-version", "synthetic-session-version", controller.signal)).toEqual({ kind: "integration_pending" });
  controller.abort(); expect(await sync.read("synthetic-session-version", controller.signal)).toEqual({ kind: "cancelled" });
});

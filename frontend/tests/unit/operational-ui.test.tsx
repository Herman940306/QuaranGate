import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperationalStateView } from "../../src/components/operational-read";
import { OperationalProvider } from "../../src/components/operational-provider";
import { Jobs, jobDiscoveryNotice } from "../../src/components/operational-jobs";
import { GitExecution } from "../../src/components/operational-git";
import { GitHub } from "../../src/components/operational-github";
import { stateCopy, type OperationalState } from "../../src/lib/operational/state";
describe("truthful shared UI", () => {
  it.each(Object.keys(stateCopy) as OperationalState[])("renders explicit %s state", state => { const markup = renderToStaticMarkup(<OperationalStateView state={state} />); expect(markup).toContain(stateCopy[state]); });
  it("requires no discovery and never equates completed with applied", () => { const html = renderToStaticMarkup(<OperationalProvider><Jobs /></OperationalProvider>); expect(html).toContain(jobDiscoveryNotice); expect(html).toContain("COMPLETED means reviewable evidence; only APPLIED means changes were applied."); expect(html).not.toContain("Apply changes"); });
  it("renders Git semantics and escapes raw evidence", () => { const html = renderToStaticMarkup(<GitExecution output={{ exitCode: null, stdout: "<script>private</script>", stderr: "separate stderr", timedOut: true, truncated: true, durationMs: 30 }} />); expect(html).toContain("outcome unknown"); expect(html).toContain("output truncated"); expect(html).toContain("separate stderr"); expect(html).not.toContain("<script>"); });
  it("distinguishes GitHub read from write and review", () => { const html = renderToStaticMarkup(<OperationalProvider><GitHub /></OperationalProvider>); expect(html).toContain("Read availability grants no write or review authority"); });
});

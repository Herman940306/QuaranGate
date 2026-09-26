import { Badge, Panel, Table } from "./primitives";

const models = [
  { id: "primary", role: "Primary", model: "qwen3.5:4b-q4_K_M", status: "Qualified and owner-selected" },
  { id: "reserve", role: "Capacity reserve", model: "qwen3.5:9b-q4_K_M", status: "Qualified; not automatic fallback" },
  { id: "alternate", role: "Alternate", model: "ministral-3:8b-instruct-2512-q4_K_M", status: "Qualified" },
  { id: "deferred", role: "Deferred candidate", model: "gemma4:12b-it-q4_K_M", status: "Deferred pending controlled Ollama upgrade" },
];
const deployment = [
  { id: "source", label: "O1 source implementation", value: "Complete" },
  { id: "qualification", label: "Primary/capacity/alternate model qualification", value: "Complete" },
  { id: "selection", label: "Primary model selection", value: "Frozen" },
  { id: "activation", label: "Production activation", value: "Deployed" },
  { id: "acceptance", label: "Full post-remediation live acceptance", value: "Pending / incomplete" },
];
const resources = [
  { id: "context", label: "Approved host context", value: "65536" },
  { id: "gpu", label: "Qualified GPU evidence", value: "GPU device 0 / GTX 1080 Ti; host-specific" },
  { id: "limits", label: "Runtime resource profile", value: "CPU 2.0 cores, RAM 3 GiB, PIDs 256, one loaded model" },
  { id: "cloud", label: "Cloud fallback", value: "Disabled by policy; OLLAMA_NO_CLOUD=1" },
];
export function LocalAiModels() {
  return <>
    <div className="page-heading"><div><p className="eyebrow">O1 / LOCAL MODEL PLANE</p><h1>Local AI & Models</h1><p className="page-intro">Show the accepted local-model qualification facts without inventing live model inventory, entitlement, GPU telemetry or runtime control.</p></div><Badge>Readiness only</Badge></div>
    <div className="review-grid">
      <Panel title="Owner-approved model set">
        <Table caption="Qualified local models" headings={["Role", "Model", "Status"]} rows={models.map(row => ({ id: row.id, cells: { Role: row.role, Model: row.model, Status: row.status } }))} />
        <p className="muted">There is no automatic model fallback. Moving from one qualified model to another is an explicit operator configuration decision.</p>
      </Panel>
      <Panel title="Current deployment truth">
        <Table caption="O1 deployment truth" headings={["Area", "Status"]} rows={deployment.map(row => ({ id: row.id, cells: { Area: row.label, Status: row.value } }))} />
        <p className="muted">Production deployment and model qualification are not the same as completed post-remediation live acceptance.</p>
      </Panel>
    </div>
    <div className="review-grid">
      <Panel title="Authority boundary">
        <p>O1 is a governed local Ollama backend behind the normal Agent Control Plane. Its approved profiles are audit, plan and review. Implement/writer/live mutation is not approved.</p>
        <p className="muted">The model-facing tools are read-only: read_file, list_files and literal_search. No shell, write/apply tool, GitHub operation, Docker action or browser authority is granted by this page.</p>
      </Panel>
      <Panel title="Resource evidence">
        <Table caption="Host-specific resource evidence" headings={["Metric", "Value"]} rows={resources.map(row => ({ id: row.id, cells: { Metric: row.label, Value: row.value } }))} />
        <p className="muted">Recorded VRAM/CPU/RAM measurements describe a qualified host and canary, not universal requirements or permission to silently consume those resources on another machine.</p>
      </Panel>
    </div>
    <Panel title="Fail-closed activation prerequisites">
      <p>O1 should remain disabled unless the local Ollama runtime, GPU/device placement, dedicated read-only model store, exact qualified model seed, canary matrix, trusted backend configuration and post-enable MCP acceptance have all passed.</p>
      <p className="muted">This frontend exposes no pull, switch, enable, seed, probe or provider-control button because no accepted public frontend contract exists for those operations.</p>
    </Panel>
  </>;
}

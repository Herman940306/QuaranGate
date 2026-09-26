// Route groups are shared by the desktop rail, narrow drawer and command discovery.
export const navigationGroups = [
  { label: "Workstation", routes: [
    ["/overview", "Overview"], ["/arena", "Agent Arena"], ["/projects", "Projects"], ["/targets", "Targets"],
    ["/files", "Files"], ["/terminal", "Terminal"], ["/git", "Git"], ["/processes", "Processes"],
    ["/agents", "Agents"], ["/jobs", "Jobs"], ["/approvals", "Review & Approvals"],
  ] },
  { label: "Integrations", routes: [
    ["/ide-sessions", "IDE Sessions"], ["/github", "GitHub"], ["/models", "Local AI & Models"],
    ["/providers", "Providers"], ["/agent-profiles", "Agent Profiles"], ["/control-center", "Control Center"],
  ] },
  { label: "Assurance", routes: [
    ["/monitoring", "Monitoring"], ["/statistics", "Statistics"], ["/security", "Security & Access"],
    ["/audit-evidence", "Audit & Evidence"], ["/recovery-backups", "Recovery & Backups"],
  ] },
  { label: "Workspace", routes: [
    ["/settings", "Settings"], ["/tool-lab", "Tool Lab"], ["/account", "Account"],
    ["/workspaces", "Workspaces"], ["/permissions", "Product permissions"], ["/sign-in", "Sign in"],
    ["/", "Foundation"],
  ] },
] as const;

export const productRoutes: readonly (readonly [string, string])[] = navigationGroups.flatMap(group => group.routes as readonly (readonly [string, string])[]);

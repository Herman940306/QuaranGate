# QuaranGate Frontend Visual Design Source of Truth

Owner: Herman
Status: OWNER-DIRECTED NORMATIVE FRONTEND DESIGN CONTRACT
Applies to: every QuaranGate frontend implementation, review, remediation, visual refactor, route addition, component change, screenshot qualification, and frontend convergence task
Established on branch: feature/qg-product-frontend-continuation-codex
Established after functional convergence HEAD: 2bab51ce1019546e028c28cffa49aab2f7daf08d

## 1. Purpose

This document removes an important ambiguity from the QuaranGate frontend program:

Functional implementation completeness is not the same thing as final visual-design completion.

FE11-FE16 and the bounded frontend convergence candidate established substantial functional coverage, safety behavior, route coverage, accessibility, responsive behavior, and evidence. That work is valuable and must be preserved.

It does NOT mean that the current rendered product is visually complete or that it already conforms to the owner's intended final design.

The remaining frontend program must therefore treat the current implementation as the behavioral and security baseline and the owner's visual design as the required presentation target.

The frontend is not complete until both are true:
1. functional/security behavior remains accepted; and
2. the rendered product conforms to the approved QuaranGate visual design and has passed final visual conformance review.

## 2. Mandatory agent preflight

Every agent working on any frontend task MUST read this file before inspecting or changing frontend implementation.

This requirement applies even when the prompt appears to be:
- a small bug fix;
- a one-line CSS change;
- a route addition;
- a component refactor;
- an accessibility repair;
- a test-only change;
- a screenshot/evidence task;
- a design-system change;
- a visual audit;
- a frontend integration task;
- a later continuation prompt.

Before mutation, the agent must also read the relevant portions of:
1. DESIGN.md
2. docs/frontend/CONSOLE_FRONTEND_ARCHITECTURE.md
3. docs/frontend/CONSOLE_PRODUCT_SPECIFICATION.md
4. docs/frontend/CODEX_FRONTEND_CONTINUATION_HANDOFF.md
5. the nearest route/component/tests being changed.

If an agent has not read this source of truth, it is not authorized to make frontend changes.

Every frontend handoff must include these fields:

FRONTEND_VISUAL_SOT_READ=YES
FRONTEND_VISUAL_SOT_PATH=docs/frontend/FRONTEND_VISUAL_DESIGN_SOURCE_OF_TRUTH.md
DESIGN_CONFORMANCE_SCOPE=<what was checked or changed>

## 3. Precedence

For frontend presentation and visual design, use this order when sources appear to conflict:
1. explicit current owner direction;
2. this document;
3. DESIGN.md;
4. approved current Figma/design artifacts explicitly identified by the owner;
5. current frontend architecture/product specification;
6. accepted behavioral/security contracts and phase handoffs;
7. existing rendered implementation;
8. historical screenshots or old visual implementation.

Existing UI is therefore not authoritative merely because it already exists or has functional test coverage.

Do not preserve a visibly wrong design just because it is already implemented.

At the same time, a visual redesign must not weaken accepted behavior, authority semantics, security, accessibility, state truthfulness, or test coverage.

## 4. Current frontend truth

The current frontend has a strong implementation baseline.

The FE11-FE16/convergence work establishes, among other things:
- required product surface coverage;
- same-origin governed frontend behavior;
- bounded operational reads;
- truthful unavailable/unknown states;
- authority separation;
- COMPLETED != APPLIED;
- page-memory-only settings where applicable;
- no browser credential persistence;
- responsive 1280px / 360px behavior;
- accessibility and keyboard coverage;
- Tool Lab bounded discovery;
- audit/recovery contract boundaries;
- deterministic frontend tests and evidence.

This baseline is a behavioral contract, not a visual acceptance statement.

Current classification:

FUNCTIONAL_FRONTEND_IMPLEMENTATION=SUBSTANTIALLY_COMPLETE_FOR_CURRENT_BOUNDED_SCOPE
SECURITY_AND_AUTHORITY_BEHAVIOR=IMPLEMENTED_AND_QUALIFIED_FOR_CURRENT_SCOPE
PRODUCT_SURFACE_COVERAGE=IMPLEMENTED_FOR_CURRENT_FRONTEND_ROADMAP

FINAL_OWNER_VISUAL_DESIGN=NOT_COMPLETE
PIXEL_FIGMA_ALIGNMENT=NOT_COMPLETE
FULL_VISUAL_POLISH=NOT_COMPLETE
DESIGN_SYSTEM_CONVERGENCE=NOT_COMPLETE
FINAL_VISUAL_ACCEPTANCE=NOT_COMPLETE

No later agent may change those final five fields to PASS merely because unit, build, route, or accessibility tests pass. They require dedicated rendered visual evidence and owner/independent visual acceptance.

## 5. Creative North Star

The QuaranGate frontend must feel like a precision engineering test bench / governed control workstation.

It should evoke a modern avionics, hardware-validation, or engineering-control station:
- measured;
- calm;
- precise;
- information-dense without clutter;
- explicit about authority;
- explicit about evidence;
- explicit about state;
- visually professional;
- designed for long technical sessions.

It must not look like:
- generic SaaS administration;
- a template dashboard;
- a marketing analytics product;
- neon cyberpunk;
- glassmorphism;
- a hacker-themed console;
- an oversized KPI-card wall;
- a consumer application;
- terminal-only retro UI.

The visual design exists to make governance and engineering state easier to reason about, not to decorate the product.

## 6. Normative visual language

The normative design tokens remain those in DESIGN.md.

Core target values:
- Canvas / mineral workspace: #F3F5F5
- Surface: #FFFFFF
- Surface muted: #E9EEEF
- Ink: #182128
- Ink muted: #5A6872
- Graphite authority rail: #202A31
- Rail muted: #2C3942
- Primary / Delft blue: #315E78
- Primary strong: #24495F
- Focus: #287EA8
- Success: #2C6E64
- Warning: #A65E2E
- Danger: #9A3E42
- Border: #C9D2D6
- Machine/code surface: #11181D
- Machine/code text: #E8F0F2

Typography:
- IBM Plex Sans for product UI and prose;
- IBM Plex Mono for commands, paths, hashes, tool names, JSON, logs and technical identifiers;
- 400/500 body/control weights;
- 600 compact hierarchy;
- 700 reserved for strong route/product headings.

Desktop shell:
- persistent 248px authority/navigation rail;
- fluid engineering workspace;
- 16px panel rhythm;
- 24px major-section rhythm;
- workstation-first composition;
- responsive drawer below the accepted narrow breakpoint.

The authority rail should be graphite, not pure black.
Normal workspace surfaces should remain mineral/light.
Dark presentation is reserved mainly for machine-readable output where contrast materially helps.

## 7. Signature product structure

### 7.1 Authority Strip

The Authority Strip is a structural product signature, not decoration.

It must communicate:
- Read;
- Write;
- Execution;
- Destructive;
- current authority context;
- server-controlled eligibility.

Do not hide the authority model behind generic buttons or marketing cards.

### 7.2 Trust boundary

Client -> Gateway -> Executor and related authority boundaries should be understandable in the visual hierarchy.

Do not imply:
- browser permission equals server authorization;
- product identity equals operational authority;
- a completed job has been applied;
- configuration equals live qualification;
- declared state equals machine-proven state.

### 7.3 Machine output

Logs, commands, diffs, IDs, JSON and machine evidence may use the dark technical surface.

Normal content and control chrome should not become an all-dark generic dashboard unless the owner explicitly changes the design direction.

## 8. Design implementation strategy

The final visual pass must NOT throw away the functional FE4-FE16 implementation.

Use the existing implementation as the behavioral substrate.

### VD0 - Visual baseline freeze
- preserve current functional candidate;
- record current route/test identities;
- capture representative current screenshots;
- do not redefine functionality.

### VD1 - Token and primitive convergence
- align CSS variables/tokens with DESIGN.md;
- normalize typography;
- normalize spacing/radius/borders;
- normalize buttons, inputs, selects, tables, badges, panels, dialogs, toasts and status presentation;
- remove one-off styles that conflict with the design system.

### VD2 - Shell and navigation
- implement/refine the 248px graphite authority rail;
- command/header surface;
- route hierarchy;
- authority strip;
- workstation content geometry;
- mobile/narrow drawer behavior;
- focus and keyboard navigation.

### VD3 - Primary operational surfaces
Converge:
- Overview;
- Projects;
- Targets;
- Files;
- Terminal;
- Git;
- Processes;
- Agents;
- Jobs;
- Review & Approvals;
- Agent Arena.

### VD4 - Integration/control surfaces
Converge:
- IDE Sessions;
- GitHub;
- Local AI / Models;
- Providers;
- Agent Profiles;
- Control Center.

### VD5 - Observability/governance surfaces
Converge:
- Monitoring;
- Statistics;
- Security & Access;
- Audit & Evidence;
- Recovery & Backups;
- Settings;
- Tool Lab.

### VD6 - Final product consistency
- eliminate generic SaaS remnants;
- ensure shared primitive use;
- align table density;
- align page headings;
- align status semantics;
- align empty/loading/error/unavailable presentation;
- verify no visual drift between routes.

### VD7 - Rendered visual acceptance
- desktop visual review;
- narrow visual review;
- zoom/reflow;
- keyboard;
- reduced motion;
- forced colors where applicable;
- accessibility;
- screenshot comparison against approved design references;
- owner review;
- independent visual acceptance.

Do not call the frontend visually complete before VD7.

## 9. Visual-reference use

When an approved Figma or owner-provided reference is available, agents must treat it as a real implementation target rather than as inspiration.

The task is not to create a vaguely similar theme.

Agents must compare:
- geometry;
- shell dimensions;
- spacing;
- hierarchy;
- typography;
- navigation structure;
- density;
- panel treatment;
- borders;
- status treatment;
- authority treatment;
- machine-output treatment;
- responsive behavior.

If exact source dimensions or states are unavailable, record the uncertainty rather than inventing a different design.

No agent may silently substitute a generic component-library default for an owner-approved design.

## 10. What must be preserved during visual work

Visual work must preserve all accepted security and behavioral invariants.

At minimum:
- same-origin /mcp;
- no generic privileged frontend proxy;
- server remains authority;
- browser convenience never grants authority;
- one writer per worktree;
- COMPLETED != APPLIED;
- session identity != authorization;
- missing state fails closed;
- unknown values remain UNKNOWN;
- no fake streaming;
- no fake telemetry;
- no silent provider fallback;
- no raw Docker socket authority;
- no arbitrary upstream URL;
- no browser-persisted credentials;
- no fabricated analytics;
- no fabricated model/GPU/runtime health;
- no inferred approval/permission success;
- destructive operations remain server-authorized and confirmation-gated;
- accepted accessibility behavior;
- keyboard reachability;
- reduced-motion behavior;
- bounded overflow;
- stale-result suppression/cancellation;
- error redaction;
- evidence preservation.

A design change that weakens one of these is a regression, not progress.

## 11. Existing functional screens are allowed to change visually

Do not interpret frozen FE commits as a ban on later presentation work.

A later visual-design lane may change:
- markup structure;
- component composition;
- CSS;
- layout;
- spacing;
- visual hierarchy;
- typography;
- navigation presentation;
- iconography;
- panel/table presentation;
- responsive presentation;
- semantic component primitives;

provided that:
- behavior remains equivalent or improves without authority expansion;
- contracts remain truthful;
- security invariants remain intact;
- tests are updated only where visual semantics legitimately changed;
- accepted historical evidence is preserved rather than overwritten;
- new evidence is produced for the new visual candidate.

## 12. Historical screenshots

Historical screenshots are evidence for the state they captured.

They are NOT the final design target unless the owner explicitly says so.

Never overwrite accepted historical screenshots.

For every new visual phase:
- write new evidence into a new phase/evidence directory;
- retain previous evidence hashes;
- label generated comparison images clearly;
- never replace historical bytes merely because a new design is better.

## 13. Design review checklist for every frontend change

Every frontend change must answer:
1. Does this move the UI toward the precision engineering test-bench North Star?
2. Does it follow the graphite/mineral/Delft token system?
3. Does it use IBM Plex correctly?
4. Does it preserve the Authority Strip and server-authority model?
5. Does it avoid generic SaaS patterns?
6. Does it avoid neon/glass/hacker styling?
7. Are technical identifiers treated as technical information?
8. Is state visibly distinguished between proven, unknown, unavailable, deferred, denied, destructive, completed and applied?
9. Is the layout workstation-first and still usable at narrow widths?
10. Does it preserve accessibility and keyboard behavior?
11. Does it preserve security/authority semantics?
12. Is the result compared to the approved design reference when one exists?

If the answer to a material item is no, the task is not finished.

## 14. Required validation for visual changes

At minimum, visual implementation phases should consider:
- lint;
- typecheck;
- focused unit tests;
- full frontend unit suite;
- production build;
- git diff --check;
- browser E2E;
- desktop rendered check;
- narrow rendered check;
- 200% zoom/reflow;
- axe/accessibility;
- keyboard navigation;
- focus behavior;
- reduced motion;
- overflow;
- secret/browser-persistence regression;
- authority semantics regression;
- COMPLETED != APPLIED regression;
- stale/unavailable/error-state regression;
- historical screenshot hash preservation.

Visual acceptance additionally requires deliberate screenshot inspection.

A green automated suite alone does not prove design conformance.

## 15. Status language

Agents must use precise status terms.

Allowed examples:
- FUNCTIONALLY_COMPLETE
- SOURCE_QUALIFIED
- BROWSER_QUALIFIED
- VISUAL_IMPLEMENTATION_IN_PROGRESS
- VISUAL_CONFORMANCE_PARTIAL
- VISUAL_CONFORMANCE_PASS
- INDEPENDENT_VISUAL_REVIEW_REQUIRED
- OWNER_VISUAL_ACCEPTANCE_REQUIRED

Do not use FRONTEND_COMPLETE, DESIGN_COMPLETE, FINAL_UI, or equivalent unless the final design-conformance gate has actually passed.

## 16. Agent stop conditions

Stop and report rather than invent when:
- the owner-approved visual reference is unavailable for a pixel-critical task;
- a proposed visual change would require changing backend authority;
- a component would need unsupported product data;
- a change conflicts with accepted security semantics;
- a separate writer owns the same worktree;
- historical evidence would have to be overwritten;
- a visual requirement contradicts current owner direction;
- visual acceptance cannot be proven in the available rendered environment.

## 17. Definition of frontend completion

QuaranGate frontend completion requires both tracks.

Track A - behavior/security:
- required product surfaces implemented;
- backend contracts truthful;
- security/authority invariants preserved;
- functional tests pass;
- integration boundaries honestly represented.

Track B - final visual design:
- final shell matches approved design;
- shared primitives are visually converged;
- every primary route is migrated;
- generic SaaS remnants are removed;
- desktop/narrow/zoom states are visually qualified;
- owner design direction is satisfied;
- independent rendered visual review passes.

Only after both Track A and Track B are closed may the project report:

FRONTEND_FINAL_COMPLETE=YES

Until then:

FRONTEND_FUNCTIONAL_BASELINE=AVAILABLE
FRONTEND_FINAL_VISUAL_DESIGN=OPEN

## 18. Required prompt rule

For every future frontend prompt, the agent must begin from this instruction:

MANDATORY FRONTEND PRECHECK: Read docs/frontend/FRONTEND_VISUAL_DESIGN_SOURCE_OF_TRUTH.md in full before making any frontend change. Treat it as the normative owner-directed visual-design contract. Functional acceptance does not equal final visual acceptance. Preserve accepted security/behavior while moving the rendered UI toward the approved QuaranGate design. If this file has not been read, do not mutate frontend source.

This requirement persists until the owner explicitly supersedes or removes it.

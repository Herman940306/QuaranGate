---
version: alpha
name: "QuaranGate Console"
description: "A precision workstation for operating governed AI engineering authority, evidence, targets, and agent jobs without obscuring the security boundary."
colors:
  canvas: "#F3F5F5"
  surface: "#FFFFFF"
  surface-muted: "#E9EEEF"
  ink: "#182128"
  ink-muted: "#5A6872"
  rail: "#202A31"
  rail-muted: "#2C3942"
  primary: "#315E78"
  primary-strong: "#24495F"
  focus: "#287EA8"
  success: "#2C6E64"
  warning: "#A65E2E"
  danger: "#9A3E42"
  border: "#C9D2D6"
  code: "#11181D"
  code-ink: "#E8F0F2"
typography:
  sans:
    fontFamily: "Aptos, Segoe UI Variable, Segoe UI, system-ui, sans-serif"
  display:
    fontFamily: "Aptos Display, Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
  mono:
    fontFamily: "Cascadia Code, SFMono-Regular, Consolas, Liberation Mono, monospace"
rounded:
  DEFAULT: "0.625rem"
  sm: "0.375rem"
  md: "0.625rem"
  lg: "0.875rem"
spacing:
  unit: "0.25rem"
  panel: "1rem"
  section-gap: "1.5rem"
components:
  button: {}
  card: {}
  dialog: {}
  input: {}
  toast: {}
  status-chip: {}
  command-surface: {}
---

# QuaranGate Console Design System

## Overview

### Creative North Star

QuaranGate Console should feel like a **well-instrumented engineering test bench**: measured, legible, and explicit about what is energized. The closest physical reference is a modern avionics or hardware validation station where each control has a known authority, status is visible before action, and destructive switches are visually separated rather than theatrically highlighted.

The visual identity must reinforce QuaranGate's actual product rule: the model may request work, but the control plane decides what authority exists and when a result crosses a gate.

### Product context and register

- **Audience and primary job:** developers and technical operators managing governed AI engineering work, Docker-backed workspaces, evidence, and promotion decisions.
- **Target market:** developer workstations and self-hosted engineering environments. No geography-specific behavior is assumed by this UI.
- **Locale and language policy:** English (`en`) in the initial console. Product copy is plain technical English; identifiers and backend output are not transformed.
- **Usage scene:** desktop/laptop-first, keyboard-heavy, often alongside an IDE and terminal. Narrow tablet/phone layouts remain usable for inspection and bounded actions, but dense engineering work remains optimized for a workstation.
- **Register:** product. Task clarity, evidence, authority, and stable density win over marketing expression.
- **Memorable signature:** the **Authority Strip**. Every tool/action is classified visually as Read, Write, Execution, or Destructive, and high-risk actions cross a visible confirmation gate. This is structural product information, not decoration.
- **Restraint:** source browsing, logs, diffs, results, and forms stay quiet. Code/output uses a single dark technical surface; normal application chrome remains light.
- **Anti-references:** neon cyberpunk dashboards, generic dark SaaS shells, glassmorphism, oversized KPI cards, and terminal-only retro styling. They either romanticize risk or make operational density harder to scan.
- **Token ownership/runtime mapping:** this file is the normative visual intent. Runtime values map one-to-one to CSS custom properties in `console/styles.css`; no JavaScript duplicates palette values.

## Colors

The base is mineral grey and paper white so long sessions remain readable. The rail uses graphite rather than pure black. Delft blue (`primary`) is the interaction color; it is deliberately quieter than a consumer-SaaS blue.

Semantic colors are reserved for meaning:

- `success` means server-confirmed completion or healthy/available state.
- `warning` means recoverable risk, destructive-class preparation, or degraded state.
- `danger` means destructive, failed, forbidden, or irreversible impact.
- `focus` is used only for focus/selection affordances.
- tool authority never relies on color alone; every authority chip includes text and an icon/shape treatment.

The code surface is the only intentionally dark content panel. This separates machine output from product controls without turning the entire product into a dark-theme cliché.

## Typography

`display` is used sparingly for page headings and the QuaranGate wordmark. `sans` owns controls, labels, navigation, and prose. `mono` owns commands, paths, job IDs, hashes, tool names, JSON, logs, and diff content.

Weights stay disciplined: 400/500 for body and controls, 600 for compact hierarchy, 700 only for product/route headings. Uppercase is limited to tiny technical labels such as authority classifications. Long output never inherits display typography.

## Layout

The desktop shell uses a persistent 248px navigation rail and a fluid workspace. The workspace itself is not capped to a marketing-page width; operational screens need horizontal room. Content panels use a 16px internal rhythm with 24px between major sections.

The rail collapses into an app-owned drawer below 880px. At narrow widths, dense tables and code panes own horizontal overflow rather than clipping content or shrinking identifiers into illegibility. No shared shell uses viewport-fixed height to make a child fit; each output surface owns its scrolling.

A 3-part trust ribbon—Client → Gateway → Executor—sits at the top of the overview as a status-bearing diagram. It explains the product's trust boundary and becomes the console's recurring orientation device.

## Elevation & Depth

Hierarchy is primarily tonal and bordered. Static cards have no decorative shadow. Popovers, dialogs, and the mobile drawer may use a restrained shadow because they exist above the normal plane. Sticky toolbars use an opaque surface plus border; blur is not used as a substitute for contrast.

## Shapes

Controls use a 10px family (`md`) with tighter 6px (`sm`) corners for technical chips and code affordances. Large panels use 14px (`lg`) only where they contain a distinct workflow. Pills are reserved for compact state/authority chips; buttons are not pills.

## Components

### Foundational visual states

Every interactive control defines default, hover, focus-visible, active, disabled, and busy states. Busy states preserve geometry. Read-only output never imitates editable fields. Error and forbidden states include text, not just semantic color.

The global scrollbar theme is defined at the application root and inherited by every product-owned overflow region. Reduced-motion users receive immediate state changes without transform-based entrance motion.

### Buttons and actions

Buttons combine emphasis and intent. The normal primary action is solid blue. Secondary actions are neutral outline/ghost. Warning and danger are semantically reserved.

High-impact controls (`fs_delete`, `target_stop`, `target_restart`, `agent_cancel`, `agent_apply`, `agent_discard`, and destructive-class Tool Lab calls) cross an app-owned confirmation dialog. `agent_apply` receives the strongest confirmation copy because it is the explicit boundary from stored evidence to live source mutation.

### Navigation and data display

The sidebar is route navigation, not tabs. Route state is hash-backed so Back/Forward and deep links work in a static facade. The active destination uses both a left gate marker and a background state.

Tables use semantic table markup, a sticky header where useful, stable empty/error/loading footprints, and horizontal overflow on narrow screens. Technical identifiers are monospaced and copyable only through explicit user action.

### Forms and overlays

Product forms use `novalidate` and app-owned validation. Textareas use `resize: none` and auto-grow where long input is expected. Native selects are an intentional choice for backend/profile/project/resource-policy selection: operating-system popup geometry is accepted because the option sets are small, stable, and do not require custom search.

The API key is memory-only and masked by default. Reveal state is explicit and resets when the console disconnects. The key is never written to local/session storage, a URL, toast, or console log.

Dialogs trap focus, support Escape where cancellation is valid, keep the background inert, and restore focus to the trigger. Toasts use one live region and never carry secrets or raw backend payloads.

### Iconography

Icons are authored inline as simple 1.75px-stroke SVG symbols. They are functional navigation/action marks, not illustrations. Icon-only controls always have an accessible name; important actions keep text labels.

### Motion

Motion communicates navigation selection, dialog entrance, and progress only. Typical feedback is 140–220ms with ease-out. No ambient animation runs continuously. `prefers-reduced-motion: reduce` removes transforms and nonessential transitions.

### Content and data visualization

Copy names the actual operation: “Apply verified changes,” “Stop target,” “Run command,” “Review diff.” The UI never says a job is applied when it is only completed. It never calls a local model “offline” unless network policy is independently known.

Machine output is preserved verbatim inside code surfaces. Product errors translate transport failure into a concise recovery statement while retaining a request/tool identifier when available.

## Operational observability surfaces

Monitoring, Statistics, Security & Access, Audit & Evidence, Local AI / Models, Recovery & Backups and GitHub use the same precision-test-bench visual language as the existing workstation routes. Operational metrics are compact instruments, not marketing KPI cards. Every health/provenance value must visually distinguish machine-derived `MATCH`/healthy evidence from `UNKNOWN`, declared-only policy, deferred implementation and failure.

MCP Traffic defaults to metadata-only rows. Runtime topology emphasizes trust boundaries and Docker-authority placement rather than decorative node graphs. Egress views show approved destinations and evidence state without packet-content capture. Capability matrices distinguish implementation from production qualification.

Charts are optional and must have an accessible tabular/text equivalent, explicit units/time range and honest empty/error states. No chart is preferable to fabricated or weakly sourced telemetry.

## Do's and Don'ts

- **Do:** make authority, current target/project, pending state, and evidence status visible before consequential actions.
- **Do:** preserve QuaranGate's separation between COMPLETED and APPLIED in every job-oriented screen.
- **Do:** use the dark output surface only for machine-readable content that benefits from code contrast.
- **Don't:** hide denied authority behind missing controls when the user reasonably needs to understand why an action is unavailable; show a clear forbidden state after the server denies it.
- **Don't:** imply that client-side UI permissions are security enforcement. Server authorization remains canonical.
- **Don't:** turn the console into a “hacker” aesthetic. QuaranGate is a control plane, not a threat-themed toy.

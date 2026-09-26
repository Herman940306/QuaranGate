import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { errorCopy, type ErrorCategory } from "../lib/errors";

export type Tone = "neutral" | "primary" | "verified" | "attention" | "destructive";
export function Button({ emphasis = "outline", intent = "neutral", busy = false, children, className = "", disabled, type = "button", onClick, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { emphasis?: "solid" | "outline" | "ghost"; intent?: Tone; busy?: boolean }) {
  return <button {...props} type={type} onClick={onClick} disabled={disabled || busy} aria-busy={busy || undefined} className={`button ${className}`} data-emphasis={emphasis} data-intent={intent}><span className={busy ? "button-label-busy" : undefined}>{children}</span>{busy ? <span className="button-busy" aria-hidden="true">•••</span> : null}</button>;
}
export function IconButton({ label, children, onClick, ...props }: Omit<Parameters<typeof Button>[0], "aria-label"> & { label: string }) {
  return <Button {...props} onClick={onClick} aria-label={label} title={label} className="icon-button">{children}</Button>;
}
type FieldProps = { id: string; label: string; help?: string; error?: string };
function fieldDescription({ id, help, error }: FieldProps) { return [help ? `${id}-help` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined; }
function Field({ id, label, help, error, children }: FieldProps & { children: ReactNode }) {
  return <div className="field"><label htmlFor={id}>{label}</label>{children}<div className="field-messages">{help ? <p id={`${id}-help`} className="muted">{help}</p> : null}{error ? <p id={`${id}-error`} className="field-error">{error}</p> : null}</div></div>;
}
export function Input({ id, label, help, error, ...props }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  return <Field {...{ id, label, help, error }}><input {...props} id={id} aria-invalid={Boolean(error)} aria-describedby={fieldDescription({ id, label, help, error })} /></Field>;
}
export function Textarea({ id, label, help, error, ...props }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <Field {...{ id, label, help, error }}><textarea {...props} id={id} rows={props.rows ?? 5} className="resize-none" aria-invalid={Boolean(error)} aria-describedby={fieldDescription({ id, label, help, error })} /></Field>;
}
export function Select({ id, label, help, error, children, ...props }: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  return <Field {...{ id, label, help, error }}><select {...props} id={id} aria-invalid={Boolean(error)} aria-describedby={fieldDescription({ id, label, help, error })}>{children}</select></Field>;
}
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) { return <span className="badge" data-tone={tone}>{children}</span>; }
export function Panel({ title, children, ...props }: HTMLAttributes<HTMLElement> & { title: string }) {
  return <section {...props} className={`panel ${props.className ?? ""}`}><h2>{title}</h2>{children}</section>;
}
export function LoadingState({ label = "Loading content" }: { label?: string }) { return <div className="state" data-state="loading" role="status" aria-busy="true"><strong>{label}</strong><div className="loading-line" aria-hidden="true" /><p className="muted">Waiting for content.</p></div>; }
export function EmptyState({ title = "Nothing to display", children }: { title?: string; children?: ReactNode }) { return <div className="state" data-state="empty"><h3>{title}</h3>{children ? <p className="muted">{children}</p> : null}</div>; }
export function ErrorState({ category = "unknown", children }: { category?: ErrorCategory; children?: ReactNode }) { return <div className="state error-state" data-state={category} role="alert"><h3>Unable to continue</h3><p>{errorCopy[category]}</p>{children}</div>; }
export function PermissionExplanation({ state, reason }: { state: "available" | "denied" | "unknown" | "not_implemented"; reason: string }) {
  const labels = { available: "Available · display only", denied: "Access denied", unknown: "Eligibility unknown", not_implemented: "Not implemented" };
  return <div className="permission" data-state={state}><Badge tone={state === "denied" ? "destructive" : "neutral"}>{labels[state]}</Badge><p>{reason}</p><small className="muted">Display information never grants permission. Every operation requires server authorization.</small></div>;
}
export function MachineOutput({ label, children }: { label: string; children: string }) {
  return <figure className="machine"><figcaption>{label}</figcaption>{/* biome-ignore lint/a11y/noNoninteractiveTabindex: Bounded output must be keyboard-scrollable; the named region supplies context. */}<section className="machine-scroll" tabIndex={0} aria-label={label}><pre><code>{children}</code></pre></section></figure>;
}
export type TableRow = { id: string; cells: Record<string, string> };
export function Table({ caption, headings, rows }: { caption: string; headings: string[]; rows: TableRow[] }) {
  // biome-ignore lint/a11y/noNoninteractiveTabindex: The named overflow region needs keyboard access to columns at narrow widths.
  return <section className="table-scroll" aria-label={caption} tabIndex={0}><table><caption>{caption}</caption><thead><tr>{headings.map(h => <th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id}>{headings.map(heading => <td key={heading}>{row.cells[heading]}</td>)}</tr>)}</tbody></table></section>;
}

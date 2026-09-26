"use client";
import { useId, useState, type ReactNode } from "react";
export function Tabs({ label, items }: { label: string; items: { label: string; content: ReactNode }[] }) {
  const [active, setActive] = useState(0);
  const id = useId();
  return <div><div className="tabs" role="tablist" aria-label={label}>{items.map((item, index) => <button type="button" role="tab" key={item.label} id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`} aria-selected={active === index} tabIndex={active === index ? 0 : -1} onClick={() => setActive(index)} onKeyDown={event => {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % items.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else return;
    event.preventDefault(); setActive(next); document.getElementById(`${id}-tab-${next}`)?.focus();
  }}>{item.label}</button>)}</div>{items.map((item, index) => (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Text-only tab panels need a Tab stop after the selected tab for keyboard readers.
    <div key={item.label} role="tabpanel" id={`${id}-panel-${index}`} aria-labelledby={`${id}-tab-${index}`} hidden={active !== index} tabIndex={0} className="tab-panel">{item.content}</div>
  ))}</div>;
}

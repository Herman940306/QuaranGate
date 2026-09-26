"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { MotionConfig } from "motion/react";
import { createMemoryAppearanceAdapter, type Appearance } from "../lib/appearance";

const AppearanceContext = createContext<{ value: Appearance; update: (value: Appearance) => void } | null>(null);
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [adapter] = useState(createMemoryAppearanceAdapter);
  const [value, setValue] = useState(() => adapter.read());
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.mode = value.mode;
    root.dataset.palette = value.palette;
    root.dataset.density = value.density;
  }, [value]);
  function update(next: Appearance) { adapter.write(next); setValue(adapter.read()); }
  return <AppearanceContext.Provider value={{ value, update }}><MotionConfig reducedMotion="user">{children}</MotionConfig></AppearanceContext.Provider>;
}
export function useAppearance() {
  const context = useContext(AppearanceContext);
  if (!context) throw new Error("AppearanceProvider is required");
  return context;
}

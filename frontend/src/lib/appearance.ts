export const modes = ["system", "light", "dark"] as const;
export const palettes = ["default", "mineral", "delft", "slate", "warm_workbench"] as const;
export const densities = ["comfortable", "compact"] as const;
export type Appearance = {
  mode: typeof modes[number];
  palette: typeof palettes[number];
  density: typeof densities[number];
};
export const defaultAppearance: Appearance = { mode: "system", palette: "default", density: "comfortable" };
export const paletteLabels: Record<Appearance["palette"], string> = {
  default: "QuaranGate Default", mineral: "Mineral", delft: "Delft", slate: "Slate", warm_workbench: "Warm Workbench",
};

export function parseAppearance(input: unknown): Appearance {
  if (!input || typeof input !== "object") return { ...defaultAppearance };
  const candidate = input as Record<string, unknown>;
  return {
    mode: modes.includes(candidate.mode as Appearance["mode"]) ? candidate.mode as Appearance["mode"] : "system",
    palette: palettes.includes(candidate.palette as Appearance["palette"]) ? candidate.palette as Appearance["palette"] : "default",
    density: densities.includes(candidate.density as Appearance["density"]) ? candidate.density as Appearance["density"] : "comfortable",
  };
}

// F1 deliberately uses page memory. F3 supplies the authenticated, versioned adapter.
// No persistence, user identity, secret field or network endpoint is inferred here.
export interface AppearanceAdapter {
  read(): Appearance;
  write(value: Appearance): void;
}
export function createMemoryAppearanceAdapter(): AppearanceAdapter {
  let value = { ...defaultAppearance };
  return { read: () => ({ ...value }), write: next => { value = parseAppearance(next); } };
}

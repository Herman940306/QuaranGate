"use client";
import { densities, modes, palettes, paletteLabels, type Appearance } from "../lib/appearance";
import { useAppearance } from "./appearance-provider";
import { Select } from "./primitives";
export function AppearanceControls() {
  const { value, update } = useAppearance();
  return <div className="appearance-grid">
    <Select id="appearance-mode" label="Mode" value={value.mode} onChange={e => update({ ...value, mode: e.target.value as Appearance["mode"] })}>{modes.map(mode => <option key={mode} value={mode}>{mode[0].toUpperCase() + mode.slice(1)}</option>)}</Select>
    <Select id="appearance-palette" label="Palette" value={value.palette} onChange={e => update({ ...value, palette: e.target.value as Appearance["palette"] })}>{palettes.map(palette => <option key={palette} value={palette}>{paletteLabels[palette]}</option>)}</Select>
    <Select id="appearance-density" label="Density" value={value.density} onChange={e => update({ ...value, density: e.target.value as Appearance["density"] })}>{densities.map(density => <option key={density} value={density}>{density[0].toUpperCase() + density.slice(1)}</option>)}</Select>
    <p className="muted appearance-note">Foundation preview · preferences last until this page is reloaded. Account persistence is not connected.</p>
  </div>;
}

import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./globals.css";
import { AppearanceProvider } from "../components/appearance-provider";
import { OverlayProvider } from "../components/overlays";
export const metadata: Metadata = { title: { default: "QuaranGate Foundation", template: "%s — QuaranGate" }, description: "QuaranGate frontend foundation. No operational connection.", robots: { index: false, follow: false } };
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" data-mode="system" data-palette="default" data-density="comfortable"><body><AppearanceProvider><OverlayProvider>{children}</OverlayProvider></AppearanceProvider></body></html>;
}

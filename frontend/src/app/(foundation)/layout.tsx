import type { ReactNode } from "react";
import { Shell } from "../../components/shell";
export default function FoundationLayout({ children }: { children: ReactNode }) { return <Shell engineering={process.env.NODE_ENV === "development"}>{children}</Shell>; }

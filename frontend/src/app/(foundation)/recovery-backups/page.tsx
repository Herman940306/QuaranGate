import type { Metadata } from "next";
import { RecoveryBackups } from "../../../components/recovery-backups";
export const metadata: Metadata = { title: "Recovery & Backups" };
export default function Page() { return <RecoveryBackups />; }

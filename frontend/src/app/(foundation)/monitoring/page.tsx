import type { Metadata } from "next";
import { MonitoringCenter } from "../../../components/monitoring-center";
export const metadata: Metadata = { title: "Monitoring" };
export default function Page() { return <MonitoringCenter />; }

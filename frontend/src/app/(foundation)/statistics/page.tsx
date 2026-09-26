import type { Metadata } from "next";
import { StatisticsCenter } from "../../../components/statistics-center";
export const metadata: Metadata = { title: "Statistics" };
export default function Page() { return <StatisticsCenter />; }

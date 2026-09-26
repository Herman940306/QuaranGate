import type { Metadata } from "next";
import { Permissions } from "../../../components/identity-permissions";
export const metadata: Metadata = { title: "Product permissions" };
export default function Page() { return <Permissions />; }

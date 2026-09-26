import type { Metadata } from "next";
import { Account } from "../../../components/identity-account";
export const metadata: Metadata = { title: "Account" };
export default function Page() { return <Account />; }

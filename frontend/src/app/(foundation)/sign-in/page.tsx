import type { Metadata } from "next";
import { SignIn } from "../../../components/identity-sign-in";
export const metadata: Metadata = { title: "Sign in" };
export default function Page() { return <SignIn />; }

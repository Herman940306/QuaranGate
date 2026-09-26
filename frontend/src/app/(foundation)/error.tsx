"use client";
import { Button, ErrorState } from "../../components/primitives";
export default function ErrorBoundary({ reset }: { error: Error & { digest?: string }; reset: () => void }) { return <ErrorState category="unknown"><Button onClick={reset}>Try rendering again</Button></ErrorState>; }

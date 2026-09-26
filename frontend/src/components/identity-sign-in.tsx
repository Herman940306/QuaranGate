"use client";
import Link from "next/link";
import { useIdentity } from "./identity-provider";
import { IdentityFeedback } from "./identity-status";
import { Badge, Button, Panel } from "./primitives";
export function SignIn() {
  const { integrated, pending, store, state } = useIdentity();
  const active = state.kind === "active" || state.kind === "expiring";
  return <><div className="page-heading"><div><p className="eyebrow">PRODUCT IDENTITY</p><h1>Sign in</h1><p className="page-intro">Use your identity provider to access your product account.</p></div><Badge>Server-controlled session</Badge></div>
    <Panel title="Identity provider"><p>QuaranGate does not collect your username or password. Sign-in will redirect through Keycloak when the identity service is integrated. Enterprise federation may be provided through Keycloak; federation does not grant operational authority.</p>
      {!integrated ? <p className="permission">Identity service not integrated yet. Sign-in is unavailable.</p> : null}
      <div className="form-actions"><Button emphasis="solid" disabled={!integrated || active} busy={Boolean(pending)} onClick={() => void store.beginLogin()}>Continue to identity provider</Button>{pending ? <Button onClick={store.cancel}>Cancel request</Button> : null}<Link href="/account">View account</Link></div>
      <IdentityFeedback />
    </Panel></>;
}

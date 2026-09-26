"""Bounded, redacted frontend-source check; run from repository root."""
import hashlib
import json
from pathlib import Path
import re

patterns = {
    "private_key": r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    "github_token": r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b",
    "openai_key": r"\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b",
    "aws_key": r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
    "jwt": r"\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b",
}
paths = sorted(p for root in (Path("frontend/src"), Path("frontend/tests"))
               for p in root.rglob("*") if p.is_file()
               and p.suffix in {".ts", ".tsx", ".js", ".mjs", ".css"})
findings = []
for p in paths:
    source = p.read_text()
    for label, pattern in patterns.items():
        if re.search(pattern, source):
            findings.append({"path": str(p), "category": label})
    if str(p).startswith("frontend/src/") and re.search(
        r"\b(?:localStorage|sessionStorage|indexedDB)\b|document\.cookie|console\.(?:log|debug)\s*\(|serviceWorker", source
    ):
        findings.append({"path": str(p), "category": "persistence_or_logging"})
print(json.dumps({
    "scope": "frontend source/tests only; no credentials/config/dependencies read",
    "files": len(paths),
    "result": "PASS" if not findings else "FAIL",
    "findings": findings,
    "limitations": "High-signal pattern scan, not exhaustive secret detection; browser tests separately check storage.",
    "source_hashes": {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths},
}, indent=2))
raise SystemExit(bool(findings))

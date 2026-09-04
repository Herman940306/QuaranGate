# Tini Provenance

## Component Information

**COMPONENT:** Tini

**VERSION:** 0.19.0

**ARCHITECTURE:** amd64

**LICENSE:** MIT

## Purpose

Container init / signal forwarding / child process reaping for QuaranGate runtime containers.

## Source Method

Extracted locally from an already-trusted QuaranGate runtime image. No network download was performed during vendoring.

## Source Details

**SOURCE_IMAGE:** quarangate:executor-9d025ec629329ff0f1f25c9358d98dda239ff9de

**SOURCE_IMAGE_ID:** sha256:add48a1248a5bf7fb193965d0e66544eabfa1453eacdbe6ce21868d98428e65e

**SOURCE_PATH:** /sbin/tini

## Verification

**SHA256:** 1358f1be32dc2a0dd8084dbda675c3b3dde8352b519b7b8a65573262551ad0fc

**FILE_TYPE:** ELF 64-bit LSB pie executable, x86-64, dynamically linked

**DEPENDENCIES:** libc.musl-x86_64.so.1

## License Source

**LICENSE_SOURCE:** Emitted by the trusted Tini binary using its built-in `-l` license output

The MIT license text was captured by executing the exact trusted vendored binary with the `-l` flag, which outputs the license text to stdout. This ensures the license came directly from the binary's own license disclosure mechanism without network access.

## Upstream Project

**UPSTREAM_PROJECT:** Tini / krallin/tini

**UPSTREAM_URL:** https://github.com/krallin/tini

**COPYRIGHT_HOLDER:** Thomas Orozco <thomas@orozco.fr> (2015)

## Alpine Package Information

- Package: tini-0.19.0-r3
- Maintainer: Danilo Bürger <danilo@feastr.de>
- License: MIT (as declared in Alpine package metadata)

## Security / Reproducibility Note

The vendored binary is intentionally fixed so QuaranGate container builds do not need to resolve an unpinned Alpine tini package at build time. This ensures:

1. **Build reproducibility**: Builds work without network access
2. **Version stability**: Explicit control over tini version changes
3. **Supply chain integrity**: Binary hash verification at build time

Upgrading Tini requires a separately reviewed dependency change.

## Remediation Context

- **Task:** QUARANGATE — OFFLINE BUILD REPRODUCIBILITY REMEDIATION C2 R1
- **Date:** 2026-09-04
- **Baseline Commit:** 592dae081fe1d56e44c74607bc4aee5fca044de1

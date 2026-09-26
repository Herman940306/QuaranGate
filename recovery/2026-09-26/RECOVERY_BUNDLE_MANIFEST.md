# QuaranGate Recovery Bundle — 2026-09-26

Purpose: additive safety backup of the local all-refs Git bundle after branch recovery.

This branch is a preservation branch only. It is not a product merge, release, acceptance verdict, or canonical promotion.

## Original bundle

File name:

`quarangate-all-refs-recovery-20260926.bundle`

SHA-256:

`e15002ddd6944410b980bd630b40407cad854eedb43ce16a5485afb99fc39cc2`

Size:

`8260163` bytes

Git blob SHA-1 of unsplit bundle:

`cf7ad61e0d90adf0e32e0a4089ea09847c29decc`

Bundle verification before upload:

`git bundle verify` PASS

Included branch refs at final rebuild:

`138`

Key refs captured:

- `integrate/quarangate-forward` -> `52b78f1723e798aeec80c020065846b1b0efeabe`
- `control/project-closure` -> `60c972596663e9d0707ce29b3dfd55d035ece44a`
- `main` -> `09672d5150075741bb7fdc48f5e9cce1eba07cca`
- `safety/qg-product-be7-recovered-20260926` -> `4ad43ec34bda05108ca13b9c0d1f81d4ae40de3b`

## Split chunks

The bundle was split only because connector transfer limits are below the bundle size.

| Chunk | Bytes | SHA-256 | Git blob SHA-1 |
|---|---:|---|---|
| `quarangate-all-refs-recovery-20260926.bundle.chunk00` | 3000000 | `372894e0e11b68c1cc306e700ce2f54ce13e14cecb0ee62a54af941bb05417ae` | `2e1d61c40cc19c270e7c02220ded2d33e6df5295` |
| `quarangate-all-refs-recovery-20260926.bundle.chunk01` | 3000000 | `c01d01ee3ccd5a53f573c6b54151bed3982f4a104b8d6e307aff762f7da5d6a3` | `fe79133b28bad4f62ee2019bde4fbd05ddb406c9` |
| `quarangate-all-refs-recovery-20260926.bundle.chunk02` | 2260163 | `90a50cf7e268d0a748b742144f66e92a4fb1a8cd0bfa55472e51efdfb1030cea` | `8968e01d3fa1c4fcec58a2c9136871641c656939` |

Local recombine proof before upload:

```bash
cat quarangate-all-refs-recovery-20260926.bundle.chunk00 \
    quarangate-all-refs-recovery-20260926.bundle.chunk01 \
    quarangate-all-refs-recovery-20260926.bundle.chunk02 | sha256sum
# e15002ddd6944410b980bd630b40407cad854eedb43ce16a5485afb99fc39cc2  -
```

## Restore procedure

From this branch, download all three `.chunk*` files, then run:

```bash
cat quarangate-all-refs-recovery-20260926.bundle.chunk00 \
    quarangate-all-refs-recovery-20260926.bundle.chunk01 \
    quarangate-all-refs-recovery-20260926.bundle.chunk02 \
  > quarangate-all-refs-recovery-20260926.bundle

sha256sum quarangate-all-refs-recovery-20260926.bundle
# must equal e15002ddd6944410b980bd630b40407cad854eedb43ce16a5485afb99fc39cc2

git bundle verify quarangate-all-refs-recovery-20260926.bundle
```

Then clone or inspect as needed:

```bash
git clone quarangate-all-refs-recovery-20260926.bundle recovered-quarangate
```

## Safety notes

- No default branch was changed by creating this backup branch.
- No existing branch was force-updated.
- No branch deletion, merge, reset, clean, container deletion, or product deployment is implied.
- Dirty local `main` was intentionally not swept into Git. A hash-only inventory exists in project-control.
- Local authorization/configuration files were intentionally excluded from Git safety refs.

# F1 dependencies

Registry metadata checked 2026-09-26. Exact direct versions and transitive integrity are locked with npm.

- Next.js / React / React DOM: owner-selected App Router and component/rendering runtime; MIT.
- Tailwind / PostCSS adapter: owner-selected semantic styling compiler; MIT.
- Motion: owner-selected spring system and reduced-motion handling; MIT.
- Fontsource IBM Plex Sans/Mono: local licensed font distribution, no runtime CDN; OFL-1.1.
- TypeScript 6 and React/Node types: strict application contracts; Apache-2.0 / MIT. TypeScript 7 was rejected because the current Next ESLint stack does not support it.
- Biome: maintained TypeScript/React static lint; MIT or Apache-2.0. ESLint 10 was rejected because the current TypeScript and React lint-plugin chain fails or declares incompatible peer ranges. Next build/typecheck remain framework gates; browser axe owns rendered accessibility checks.
- Vitest: deterministic unit and server-render component assertions; MIT.
- Playwright: real browser interaction, keyboard, responsive and route checks; Apache-2.0.
- axe Playwright integration: automated accessibility checks beyond platform assertions; MPL-2.0.

The platform supplies dialogs, selects, focus management and fields. No component kit, global state library, proxy, backend SDK, or database dependency is introduced. Dependency audit results belong to the candidate evidence; metadata alone is not security qualification.

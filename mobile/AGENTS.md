This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run typecheck, `npx expo-doctor` and the repo root's `pnpm test` before declaring any task done. Lint is not set up in this project.

## This app: Takar Stok

- Staff count stock and record deliveries by scanning barcodes, on the same Supabase database as the Takar web app in the repo root. Design: `../docs/superpowers/specs/2026-11-17-takar-stok-app-design.md`. How to run, pair and build: `../docs/MOBILE.md`.
- **No router.** The app has six screens switched by state in `App.tsx`; Android's back button goes through `BackHandler`. Do not add Expo Router for this.
- **Logic lives outside this folder.** Everything that decides something (barcodes, counts, deliveries, the offline queue, sending) is plain TypeScript in `../src/stok/`, next to Takar's unit maths in `../src/domain/`. Metro bundles both through `watchFolders` in `metro.config.js`. Their tests are in `../tests/unit/` and run with `pnpm test` from the repo root. Those files must not import React Native, Expo, the DOM or Node.
- This folder holds only platform glue (`src/platform/`), state (`src/state.tsx`), and screens (`src/ui/`, `src/screens/`). It has its own npm lockfile and is not a workspace of the web app.
- Stock changes only through the server's `apply_operation`; the phone never shows expected stock during a count.
- UI text is Indonesian.

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

# BHAI AI YouTube Studio

A single-owner production desk for developing original Hindi and Hinglish YouTube stories, scripts, and scene plans with owner-controlled project data.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (the Replit workflow supplies `PORT`)
- `pnpm --filter @workspace/youtube-studio run dev` — run the web app (the artifact workflow supplies `PORT` and `BASE_PATH`)
- `pnpm run typecheck` — full typecheck across all packages
- `PORT=20994 BASE_PATH=/ pnpm --filter @workspace/youtube-studio run build` — production build for this web artifact
- `pnpm --filter @workspace/api-server run build` — production API bundle
- `pnpm run build` — workspace-wide typecheck/build; Vite build commands need an artifact-specific `PORT` and `BASE_PATH`
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — apply the Drizzle schema to the configured development database
- Required server environment: `DATABASE_URL`, Clerk's server key, `SESSION_SECRET`
- Required browser environment: Clerk's publishable key
- Optional local inference: `STUDIO_OLLAMA_URL` and a manually installed, explicitly selected `STUDIO_OLLAMA_MODEL`
- Optional YouTube OAuth: server-side `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, and exact callback `YOUTUBE_REDIRECT_URI`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- Web app and responsive studio UI: `artifacts/youtube-studio`
- Authenticated API and durable job worker: `artifacts/api-server`
- PostgreSQL schema: `lib/db/src/schema/studio.ts`
- Source-of-truth API contract: `lib/api-spec/openapi.yaml`
- Generated client hooks and request schemas: `lib/api-client-react` and `lib/api-zod`
- Self-host and model setup notes: `artifacts/youtube-studio/README.md`

## Architecture decisions

- The studio is single-owner; the first authenticated account claims the owner slot. Restrict account creation before exposing an uninitialized instance publicly.
- Jobs are stored in PostgreSQL and resumed after API restart. Retries are bounded; only validated Ollama results are marked successful.
- Paid model APIs are not used. Local Ollama is opt-in and never downloaded or silently selected by the app.
- YouTube refresh tokens are encrypted server-side using a key derived from the stable `SESSION_SECRET`. Preserve that secret for channel reconnect-free migration.
- YouTube publishing is implemented as an owner-approved queued workflow for completed MP4s; a connected Google OAuth grant with the upload scope is still required. Live upload was not verified in the development environment.

## Product

The current working slice provides project/script editing, reusable text character profiles, scene editing, durable story and scene-breakdown jobs, engine health, a JSON data backup/restore flow, a FFmpeg MP4 renderer, owner-only MP4 and generated JPEG thumbnail downloads, optional local ComfyUI stills and Piper narration, optional user-supplied soundtrack mixing, and an owner-approved YouTube upload queue. Real story/scene generation requires a reachable, locally installed Ollama model; image/voice/music adapters need explicit host configuration. True video-diffusion/3D clips, character-reference consistency, lip-sync and original AI-generated sound effects/music remain unimplemented. The repository CI has a render/ffprobe smoke test; live Replit deployment and real YouTube uploads still need end-to-end verification.

## User requirements

- Keep the core independent of paid AI providers, preserve owner control, and clearly distinguish tested functionality from unverified or unavailable engines.
- Never report generation, rendering, an upload, media, analytics, or success unless the real provider/API has confirmed it and the output has passed validation.

## Gotchas

- The browser talks to the API through same-origin `/api`; do not enable reflective credentialed CORS.
- The initial owner account is selected by first authenticated API use. Lock down sign-up or place the service behind a trusted access gate before first use on a public host.
- JSON backup covers project records, scripts, scenes, and characters—not job history, OAuth tokens, model weights, or media files. Keep a separate PostgreSQL backup.
- YouTube requires a Google OAuth application whose registered callback exactly matches `YOUTUBE_REDIRECT_URI`; uploads remain explicit owner actions and should be tested private-first.
- The Replit-managed Clerk setup is not self-hosted authentication. VPS migration requires a compatible authentication provider and corresponding middleware configuration.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

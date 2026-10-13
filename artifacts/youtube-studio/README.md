# BHAI AI YouTube Studio

This is a single-owner writing and production-planning studio for Hindi and Hinglish YouTube stories. The app keeps project records in PostgreSQL and supports opt-in local text generation through Ollama. It does not call paid AI services or download models automatically.

## What currently works

- Clerk-protected studio pages with a public landing page and a single owner slot.
- Persisted projects, editable scripts, scene breakdowns, and reusable text character profiles.
- A PostgreSQL-backed job queue with cancellation, bounded transient retries, and recovery of interrupted work after API restart.
- Local-engine health checks for Ollama, ComfyUI, FFmpeg, Piper, and optional Google OAuth settings.
- Ollama story and scene-breakdown jobs, enabled only when a matching local model is installed and reachable. Generated scripts/scenes must pass output structure and length checks before they are saved as successful.
- JSON export and transactional restore for project, scene, and character records.
- Optional Google YouTube OAuth connection and authorized channel statistics / estimated-revenue queries. Refresh tokens are AES-GCM encrypted server-side.

The following production features are **not implemented**: image/video generation jobs, reference-image uploads, speech synthesis jobs, audio/SFX/music mixing, video editing/rendering, subtitle burning, thumbnail generation, Shorts conversion, and YouTube video uploads. FFmpeg being installed or ComfyUI/Piper being reachable is not evidence that those workflows are wired up. No output file, upload, or generated asset is reported as successful by this build.

## Replit operation

The workspace has separate web and API workflows. The database schema is applied with:

```sh
pnpm --filter @workspace/db run push
```

Open the web artifact, sign in, and create the first project. The first authenticated account to make a protected API request claims the single-owner slot. Configure the Clerk sign-up policy before publishing so an unintended user cannot claim a fresh instance.

## Local text generation

Install Ollama on a machine reachable by the API process. Select and install a model yourself, review that exact model's license and intended-use terms, and set:

```text
STUDIO_OLLAMA_URL=http://127.0.0.1:11434
STUDIO_OLLAMA_MODEL=<the exact installed model tag>
```

Do not expose Ollama's unauthenticated port to the public internet. When Ollama runs on another machine, put it behind a private network or authenticated TLS reverse proxy. Pin the exact model tag and record the model source/version or digest in your own deployment manifest; the app does not pull, update, or verify weights. The health page checks that the service responds and that the exact model name is present. It does not certify model quality, license, or GPU compatibility.

Hardware depends on the selected model, quantization, context size, and generation speed. As a planning estimate, a 7–8B quantized text model often needs roughly 5–8 GB of available memory for weights and more memory for runtime/context; 16 GB system RAM is a practical starting point, while a supported GPU with sufficient VRAM improves throughput. CPU inference may work but can be slow for long scripts. Check the chosen model's own hardware guidance before downloading it. Images, video, and voice have no working generation adapter in this build.

## YouTube channel connection

Create a Google OAuth application and enable the YouTube Data API and YouTube Analytics API. Set the following **server-side secrets/environment variables**:

```text
YOUTUBE_CLIENT_ID
YOUTUBE_CLIENT_SECRET
YOUTUBE_REDIRECT_URI=https://<your-host>/api/studio/youtube/callback
```

Register that exact redirect URI in the Google OAuth client. The owner must approve channel read and analytics scopes in the Google consent flow. The current build does not request an upload scope and cannot upload videos. Analytics only appear when YouTube authorizes them; estimated revenue can be unavailable for non-monetized channels or accounts without the required permission.

The Google OAuth refresh token is stored encrypted in the owner row. Encryption derives from `SESSION_SECRET`; retain the same secret across backups and VPS migration or reconnect the channel. OAuth credentials and tokens are never sent to the browser. No live Google account or API quota was available to verify this integration in the current environment.

## Backups and data ownership

The Settings page exports/restores a JSON backup of projects, scripts, scenes, and character text profiles. Restore replaces the current project records; the UI asks for confirmation. This JSON does not include job history, OAuth credentials, model files, or media assets.

For a complete database backup, use a protected PostgreSQL dump:

```sh
pg_dump --format=custom --no-owner "$DATABASE_URL" > studio-$(date +%F).dump
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" studio-YYYY-MM-DD.dump
```

Store backups outside the application checkout, encrypt them at rest, and test restores on a separate database. The app currently has no media storage directory or asset-file backup contract.

## Replit-to-Linux-VPS migration

1. Prepare a supported Linux host with Node.js 24, pnpm, PostgreSQL, and a reverse proxy with HTTPS. FFmpeg can be installed for future rendering work, but this build has no render job.
2. Clone the project and install the workspace dependencies with `pnpm install`.
3. Create an empty PostgreSQL database and set `DATABASE_URL`.
4. Set a long random `SESSION_SECRET`; keep it stable for encrypted OAuth-token recovery. Configure an authentication provider. The current Clerk tenant is Replit-managed, so VPS deployment requires replacing Clerk middleware/client configuration with an owner-controlled compatible provider; this migration adapter is not included yet.
5. Configure the API's required auth settings and database, and set the web artifact's `BASE_PATH=/` and `PORT`. Put the web application behind the reverse proxy and route `/api/*` to the API process. Do not enable permissive credentialed CORS.
6. Apply the schema with `pnpm --filter @workspace/db run push`. Build this web app with `PORT=20994 BASE_PATH=/ pnpm --filter @workspace/youtube-studio run build` and the API with `pnpm --filter @workspace/api-server run build`; serve the generated static web build while running the API on a private port.
7. Restore a studio JSON backup or PostgreSQL dump. Reconfigure secrets in the VPS secret manager; never copy them into source control. Configure Google OAuth with the VPS callback if YouTube connection is used.
8. If using local text generation, install Ollama and a manually selected, license-reviewed model on a private network, pin `STUDIO_OLLAMA_MODEL`, and check the Engines page before submitting a job.

The current Replit PostgreSQL database remains the source of truth until you explicitly migrate it. No Replit deployment or production health check has been performed.

# BHAI AI YouTube Studio

This is a single-owner Hindi/Hinglish YouTube story studio. It stores projects in PostgreSQL and supports local Ollama story writing, timed scene planning, and a real FFmpeg MP4 renderer. When configured, a ComfyUI API-format workflow generates per-scene still artwork and Piper synthesizes local narration. No model weights are downloaded automatically and no paid AI provider is called.

## What currently works

- Clerk-protected studio pages with a public landing page and a single owner slot.
- Persisted projects, editable scripts, scene breakdowns, and reusable text character profiles.
- A PostgreSQL-backed job queue with cancellation, bounded transient retries, and recovery of interrupted work after API restart.
- Local-engine health checks for Ollama, ComfyUI, FFmpeg, Piper, and optional Google OAuth settings.
- MP4 export using animated scene stills, scene headings and script captions; optional ComfyUI still-image generation, Piper narration, and a local soundtrack file; owner-only MP4 and automatic first-frame JPEG thumbnail downloads.
- Ollama story and scene-breakdown jobs, enabled only when a matching local model is installed and reachable. Generated scripts/scenes must pass output structure and length checks before they are saved as successful.
- JSON export and transactional restore for project, scene, and character records.
- Optional Google YouTube OAuth connection, authorized channel statistics / estimated-revenue queries, and user-approved resumable MP4 uploads. Refresh tokens are AES-GCM encrypted server-side.

The MP4 pipeline does not yet generate true video-diffusion/3D clips, use uploaded character-reference images, lip-sync characters, synthesize original music/SFX, or convert an existing landscape project into a vertical Short. A user-supplied local soundtrack can be mixed at low volume, and the renderer exports a JPEG thumbnail from the finished MP4. ComfyUI still-image generation and Piper narration are optional and work only when correctly configured. If those optional engines are absent, the pipeline creates a storyboard-card MP4 and reports missing artwork/narration honestly. The final MP4 is stored under `STUDIO_MEDIA_DIR` (default `./data/studio-media`); configure persistent storage on your host to keep it across restarts/redeployments.

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

Hardware depends on the selected model, quantization, context size, and generation speed. As a planning estimate, a 7–8B quantized text model often needs roughly 5–8 GB of available memory for weights and more memory for runtime/context; 16 GB system RAM is a practical starting point, while a supported GPU with sufficient VRAM improves throughput. CPU inference may work but can be slow for long scripts. Check the chosen model's own hardware guidance before downloading it. ComfyUI still-image generation and Piper voice narration are optional adapters when configured; true generative video is not implemented.

## Local media rendering setup

The MP4 renderer requires FFmpeg with H.264/AAC support and a readable font. For Hindi captions, set `STUDIO_FONT_FILE` to a Devanagari-capable font file. Optional ComfyUI image generation uses an API-format workflow exported from ComfyUI; place it on the API host and set:

```text
STUDIO_COMFY_URL=http://127.0.0.1:8188
STUDIO_COMFY_IMAGE_WORKFLOW=/absolute/path/to/workflow_api.json
STUDIO_COMFY_PROMPT_NODE_ID=<node id whose inputs.text is the positive prompt>
STUDIO_COMFY_NEGATIVE_NODE_ID=<optional negative prompt node id>
STUDIO_COMFY_TIMEOUT_MS=240000
```

The positive prompt node must contain `inputs.text`. If an image-generation attempt fails, that scene falls back to a storyboard card and the job message reports the failure. Workflow reachability alone does not certify model quality or hardware compatibility.

Optional Piper narration and media output location use:

```text
STUDIO_PIPER_BIN=/absolute/path/to/piper
STUDIO_PIPER_MODEL=/absolute/path/to/voice.onnx
STUDIO_MUSIC_FILE=/absolute/path/to/royalty-cleared-background-music.wav
STUDIO_MUSIC_VOLUME=0.12
STUDIO_FFMPEG_BIN=ffmpeg
STUDIO_MEDIA_DIR=/absolute/path/to/persistent/studio-media
```

No model is downloaded automatically. Check model license, language support, storage and memory needs. Use a soundtrack file you have rights to use; it loops under the rendered video's narration and `STUDIO_MUSIC_VOLUME` defaults to 0.12 (maximum accepted value 0.5). Current output is pan/zoom-animated stills, not true 3D animation or generative video. Original AI music/SFX generation and lip-sync are not implemented; the first-frame JPEG thumbnail is generated from the finished MP4.

## YouTube channel connection

Create a Google OAuth application and enable the YouTube Data API and YouTube Analytics API. Set the following **server-side secrets/environment variables**:

```text
YOUTUBE_CLIENT_ID
YOUTUBE_CLIENT_SECRET
YOUTUBE_REDIRECT_URI=https://<your-host>/api/studio/youtube/callback
```

Register that exact redirect URI in the Google OAuth client. The owner must approve channel-read, upload and analytics scopes in the Google consent flow. The app requests YouTube upload permission as well as analytics scopes. The owner selects a completed MP4, title, description and visibility and explicitly queues each upload. A previously connected channel may need to refresh its Google grant so the new upload scope is allowed. Interrupted transfers are marked failed rather than blindly retried because the upload might already have reached YouTube. Analytics only appear when authorized; estimated revenue can be unavailable for non-monetized channels or accounts without the required permission.

The Google OAuth refresh token is stored encrypted in the owner row. Encryption derives from `SESSION_SECRET`; retain the same secret across backups and VPS migration or reconnect the channel. OAuth credentials and tokens are never sent to the browser. No live Google account or API quota was available to verify this integration in the current environment.

## Backups and data ownership

The Settings page exports/restores a JSON backup of projects, scripts, scenes, and character text profiles. Restore replaces the current project records; the UI asks for confirmation. This JSON does not include job history, OAuth credentials, model files, or media assets.

For a complete database backup, use a protected PostgreSQL dump:

```sh
pg_dump --format=custom --no-owner "$DATABASE_URL" > studio-$(date +%F).dump
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" studio-YYYY-MM-DD.dump
```

Store backups outside the application checkout, encrypt them at rest, and test restores on a separate database. The JSON backup omits rendered media files and job history. Keep `STUDIO_MEDIA_DIR` on persistent storage and back up its MP4 files separately; a database backup alone does not include those files.

## Replit-to-Linux-VPS migration

1. Prepare a supported Linux host with Node.js 24, pnpm, PostgreSQL, FFmpeg (with H.264/AAC support), a readable font, and a reverse proxy with HTTPS. Configure persistent storage for `STUDIO_MEDIA_DIR`.
2. Clone the project and install the workspace dependencies with `pnpm install`.
3. Create an empty PostgreSQL database and set `DATABASE_URL`.
4. Set a long random `SESSION_SECRET`; keep it stable for encrypted OAuth-token recovery. Configure an authentication provider. The current Clerk tenant is Replit-managed, so VPS deployment requires replacing Clerk middleware/client configuration with an owner-controlled compatible provider; this migration adapter is not included yet.
5. Configure the API's required auth settings and database, and set the web artifact's `BASE_PATH=/` and `PORT`. Put the web application behind the reverse proxy and route `/api/*` to the API process. Do not enable permissive credentialed CORS.
6. Apply the schema with `pnpm --filter @workspace/db run push`. Build this web app with `PORT=20994 BASE_PATH=/ pnpm --filter @workspace/youtube-studio run build` and the API with `pnpm --filter @workspace/api-server run build`; serve the generated static web build while running the API on a private port.
7. Restore a studio JSON backup or PostgreSQL dump. Reconfigure secrets in the VPS secret manager; never copy them into source control. Configure Google OAuth with the VPS callback if YouTube connection is used.
8. If using local text generation, install Ollama and a manually selected, license-reviewed model on a private network, pin `STUDIO_OLLAMA_MODEL`, and check the Engines page before submitting a job.

The current Replit PostgreSQL database remains the source of truth until you explicitly migrate it. No Replit deployment or production health check has been performed.

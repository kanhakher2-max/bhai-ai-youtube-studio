import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { readComfyWorkflow } from "./studioEngines";

export type RenderScene = {
  sequence: number;
  title: string;
  durationSeconds: number;
  action: string;
  dialogue: string;
  narration: string;
  visualPrompt: string;
};
type ComfyNode = { class_type?: string; inputs?: Record<string, unknown> };
type ComfyImage = { filename?: string; subfolder?: string; type?: string };
type ComfyHistory = Record<string, { outputs?: Record<string, { images?: ComfyImage[] }>; status?: { status_str?: string } }>;
export type StudioRenderResult = {
  outputPath: string;
  mode: "comfyui-stills" | "storyboard-cards";
  hasNarration: boolean;
  warnings: string[];
};

function run(exe: string, args: string[], signal: AbortSignal, input?: string, timeoutMs = 180_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Video rendering was cancelled."));
    const child = spawn(exe, args, { stdio: ["pipe", "ignore", "pipe"], signal, windowsHide: true });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-3_000); });
    child.once("error", (error) => { clearTimeout(timer); reject(new Error("Could not start " + exe + ": " + error.message)); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (signal.aborted) reject(new Error("Video rendering was cancelled."));
      else if (code !== 0) reject(new Error(exe + " failed (exit " + String(code) + "): " + stderr.slice(-800)));
      else resolve();
    });
    child.stdin.end(input ?? "");
  });
}
function mediaDir(): string { return path.resolve(process.env.STUDIO_MEDIA_DIR || "./data/studio-media"); }
export function studioVideoPath(projectId: string): string {
  if (!/^[0-9a-f-]{36}$/iu.test(projectId)) throw new Error("Invalid project ID.");
  return path.join(mediaDir(), projectId + ".mp4");
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("Video rendering was cancelled."));
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(new Error("Video rendering was cancelled.")); };
    signal.addEventListener("abort", abort, { once: true });
  });
}
function caption(value: string, max: number, maxLines: number): string {
  const words = value.replace(/[\r\t]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 3_500).split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? current + " " + word : word;
    if (candidate.length > max && current) { lines.push(current); current = word; if (lines.length === maxLines) break; }
    else current = candidate;
  }
  if (current && lines.length < maxLines) lines.push(current);
  const count = lines.join(" ").split(/\s+/u).filter(Boolean).length;
  if (count < words.length && lines.length) lines[lines.length - 1] = (lines[lines.length - 1] || "").replace(/[.…]*$/u, "") + "…";
  return lines.join("\n");
}
function esc(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/:/gu, "\\:").replace(/'/gu, "\\'").replace(/,/gu, "\\,").replace(/\[/gu, "\\[").replace(/\]/gu, "\\]");
}
async function fontPath(): Promise<string> {
  const candidates = [process.env.STUDIO_FONT_FILE, "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf", "/usr/share/fonts/opentype/noto/NotoSansDevanagari-Regular.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf"].filter((v): v is string => Boolean(v));
  for (const item of candidates) { try { await access(path.resolve(item), constants.R_OK); return path.resolve(item); } catch { /* try next font */ } }
  throw new Error("No readable font found. Install a font or set STUDIO_FONT_FILE; Hindi captions need a Devanagari-capable font.");
}
function comfyUrl(): URL {
  const url = new URL(process.env.STUDIO_COMFY_URL || "http://127.0.0.1:8188");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("STUDIO_COMFY_URL must be an HTTP(S) base URL without credentials/query.");
  return url;
}
async function makeImage(scene: RenderScene, destination: string, signal: AbortSignal): Promise<void> {
  const workflowPath = process.env.STUDIO_COMFY_IMAGE_WORKFLOW?.trim();
  const promptNodeId = process.env.STUDIO_COMFY_PROMPT_NODE_ID?.trim();
  if (!workflowPath || !promptNodeId) throw new Error("Set STUDIO_COMFY_IMAGE_WORKFLOW and STUDIO_COMFY_PROMPT_NODE_ID.");
  const workflow = await readComfyWorkflow(workflowPath) as Record<string, ComfyNode>;
  const positive = workflow[promptNodeId];
  if (!positive?.inputs || typeof positive.inputs.text !== "string") throw new Error("The selected ComfyUI prompt node must have inputs.text; export the workflow in API format.");
  positive.inputs.text = scene.visualPrompt + "\nOriginal scene illustration. Strong composition and readable silhouettes. No text, lettering, logos, watermark, or split panels.";
  const negativeId = process.env.STUDIO_COMFY_NEGATIVE_NODE_ID?.trim();
  if (negativeId && workflow[negativeId]?.inputs && typeof workflow[negativeId]?.inputs?.text === "string") {
    workflow[negativeId]!.inputs!.text = "text, lettering, watermark, logo, blurry, distorted hands, duplicate people";
  }
  const base = comfyUrl();
  const queued = await fetch(new URL("/prompt", base), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: randomUUID() }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!queued.ok) throw new Error("ComfyUI rejected workflow with HTTP " + queued.status + ": " + (await queued.text()).slice(0, 250));
  const queuedData = await queued.json() as { prompt_id?: string };
  if (!queuedData.prompt_id) throw new Error("ComfyUI did not return prompt_id.");
  const timeout = Math.min(600_000, Math.max(30_000, Number(process.env.STUDIO_COMFY_TIMEOUT_MS) || 240_000));
  const started = Date.now();
  let image: ComfyImage | undefined;
  while (Date.now() - started < timeout) {
    await wait(1_000, signal);
    const response = await fetch(new URL("/history/" + encodeURIComponent(queuedData.prompt_id), base), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) continue;
    const history = await response.json() as ComfyHistory;
    const record = history[queuedData.prompt_id];
    if (record?.status?.status_str === "error") throw new Error("ComfyUI reported an image-generation error.");
    const images = Object.values(record?.outputs ?? {}).flatMap((item) => item.images ?? []);
    image = images.find((entry) => entry.filename && entry.type !== "temp") || images.find((entry) => entry.filename);
    if (image?.filename) break;
  }
  if (!image?.filename) throw new Error("ComfyUI timed out before returning a scene image.");
  const view = new URL("/view", base);
  view.searchParams.set("filename", image.filename);
  view.searchParams.set("subfolder", image.subfolder || "");
  view.searchParams.set("type", image.type || "output");
  const response = await fetch(view, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  if (!response.ok) throw new Error("ComfyUI image download failed with HTTP " + response.status + ".");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 40 * 1024 * 1024) throw new Error("ComfyUI returned an empty or oversized image.");
  await writeFile(destination, bytes);
}
async function piperAvailable(): Promise<boolean> {
  const bin = process.env.STUDIO_PIPER_BIN, model = process.env.STUDIO_PIPER_MODEL;
  if (!bin || !model) return false;
  try { await Promise.all([access(bin, constants.X_OK), access(path.resolve(model), constants.R_OK)]); return true; } catch { return false; }
}
async function narrate(text: string, destination: string, signal: AbortSignal): Promise<boolean> {
  const bin = process.env.STUDIO_PIPER_BIN, model = process.env.STUDIO_PIPER_MODEL;
  if (!bin || !model || !text.trim()) return false;
  try {
    await run(bin, ["--model", path.resolve(model), "--output_file", destination], signal, text.slice(0, 3_500), 90_000);
    return (await stat(destination)).size > 44;
  } catch { return false; }
}
async function renderClip(input: {
  scene: RenderScene; image: string | null; wav: string | null; output: string;
  work: string; font: string; width: number; height: number; index: number; signal: AbortSignal;
}): Promise<void> {
  const { scene, image, wav, output, work, font, width, height, index, signal } = input;
  const seconds = Math.max(1, Math.min(600, Math.round(scene.durationSeconds)));
  const titlePath = path.join(work, "title-" + index + ".txt");
  const bodyPath = path.join(work, "body-" + index + ".txt");
  await writeFile(titlePath, caption(scene.title, width > height ? 46 : 25, 2), "utf8");
  await writeFile(bodyPath, caption(scene.dialogue || scene.narration || scene.action, width > height ? 48 : 25, width > height ? 8 : 12), "utf8");
  const args = ["-y"];
  if (image) args.push("-loop", "1", "-framerate", "24", "-i", image);
  else args.push("-f", "lavfi", "-i", "color=c=" + ["0x172b4d","0x173b3f","0x3a244b","0x4a2b27","0x223748","0x30334d"][index % 6] + ":s=" + width + "x" + height + ":r=24");
  if (wav) args.push("-i", wav);
  const filters = ["scale=" + width + ":" + height + ":force_original_aspect_ratio=increase", "crop=" + width + ":" + height];
  if (image) filters.push("zoompan=z='min(zoom+0.00025,1.08)':d=1:s=" + width + "x" + height + ":fps=24");
  const escapedFont = esc(font), title = esc(titlePath), body = esc(bodyPath);
  filters.push("drawtext=fontfile='" + escapedFont + "':textfile='" + title + "':fontcolor=white:fontsize=" + (width > height ? 46 : 34) + ":x=(w-text_w)/2:y=h*0.12:box=1:boxcolor=black@0.5:boxborderw=20");
  filters.push("drawtext=fontfile='" + escapedFont + "':textfile='" + body + "':fontcolor=white:fontsize=" + (width > height ? 31 : 26) + ":line_spacing=10:x=(w-text_w)/2:y=h*0.34:box=1:boxcolor=black@0.6:boxborderw=18");
  args.push("-vf", filters.join(","), "-t", String(seconds), "-r", "24", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", "-map", "0:v:0");
  if (wav) args.push("-map", "1:a:0", "-af", "apad", "-t", String(seconds), "-c:a", "aac", "-b:a", "128k");
  else args.push("-an");
  args.push("-movflags", "+faststart", output);
  await run(process.env.STUDIO_FFMPEG_BIN || "ffmpeg", args, signal, undefined, Math.max(120_000, (seconds + 60) * 2_000));
}
export async function renderStudioVideo(input: {
  projectId: string; aspectRatio: "16:9" | "9:16"; scenes: RenderScene[];
  signal: AbortSignal; onProgress?: (complete: number, total: number, message: string) => Promise<void>;
}): Promise<StudioRenderResult> {
  if (!input.scenes.length) throw new Error("No scenes are available. Generate a storyboard before exporting.");
  const ffmpeg = process.env.STUDIO_FFMPEG_BIN || "ffmpeg";
  await run(ffmpeg, ["-version"], input.signal, undefined, 5_000);
  const font = await fontPath();
  const dir = mediaDir();
  await mkdir(dir, { recursive: true });
  const work = await mkdtemp(path.join(dir, ".render-" + input.projectId + "-"));
  const outputPath = studioVideoPath(input.projectId);
  const width = input.aspectRatio === "9:16" ? 720 : 1280;
  const height = input.aspectRatio === "9:16" ? 1280 : 720;
  const imageEnabled = Boolean(process.env.STUDIO_COMFY_IMAGE_WORKFLOW?.trim() && process.env.STUDIO_COMFY_PROMPT_NODE_ID?.trim());
  const voiceEnabled = await piperAvailable();
  const warnings: string[] = [];
  if (!imageEnabled) warnings.push("ComfyUI workflow is not configured; scene cards were used instead of generated artwork.");
  if (!voiceEnabled) warnings.push("Piper voice model is not configured/readable; no narration audio was added.");
  warnings.push("Renderer animates still artwork; true 3D/video-diffusion clips, lip-sync, music and SFX are not implemented.");
  try {
    const concatPath = path.join(work, "concat.txt");
    const clips: string[] = [];
    let narrated = 0;
    for (let i = 0; i < input.scenes.length; i += 1) {
      if (input.signal.aborted) throw new Error("Video rendering was cancelled.");
      const scene = input.scenes[i];
      if (!scene) continue;
      const serial = String(i + 1).padStart(3, "0");
      let image: string | null = null;
      if (imageEnabled) {
        const imageCandidate = path.join(work, "image-" + serial + ".png");
        try { await makeImage(scene, imageCandidate, input.signal); image = imageCandidate; }
        catch (error) {
          warnings.push("Scene " + scene.sequence + " used a storyboard card because image generation failed: " + (error instanceof Error ? error.message.slice(0, 150) : "unknown error"));
        }
      }
      let wav: string | null = null;
      if (voiceEnabled) {
        const audioCandidate = path.join(work, "voice-" + serial + ".wav");
        if (await narrate(scene.dialogue || scene.narration || scene.action, audioCandidate, input.signal)) { wav = audioCandidate; narrated += 1; }
        else warnings.push("Piper did not create narration audio for scene " + scene.sequence + ".");
      }
      const clip = path.join(work, "scene-" + serial + ".mp4");
      await renderClip({ scene, image, wav, output: clip, work, font, width, height, index: i, signal: input.signal });
      clips.push("file 'scene-" + serial + ".mp4'");
      await input.onProgress?.(i + 1, input.scenes.length, "Rendered scene " + (i + 1) + " of " + input.scenes.length);
    }
    if (!clips.length) throw new Error("No scene clips were produced.");
    await writeFile(concatPath, clips.join("\n") + "\n", "utf8");
    const temporary = path.join(work, "final.mp4");
    await run(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c", "copy", "-movflags", "+faststart", temporary], input.signal, undefined, 300_000);
    if ((await stat(temporary)).size < 1_024) throw new Error("FFmpeg created an unexpectedly small MP4.");
    await rename(temporary, outputPath);
    if (imageEnabled && !warnings.some((item) => item.includes("image generation failed"))) warnings.push("ComfyUI generated scene stills and FFmpeg added pan/zoom movement.");
    return { outputPath, mode: imageEnabled ? "comfyui-stills" : "storyboard-cards", hasNarration: narrated > 0, warnings: [...new Set(warnings)].slice(0, 30) };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

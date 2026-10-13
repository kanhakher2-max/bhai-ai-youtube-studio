import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { StudioEngine } from "@workspace/api-zod";
import { logger } from "./logger";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const DEFAULT_COMFY_URL = "http://127.0.0.1:8188";
const ENGINE_TIMEOUT_MS = 2_500;

function configuredLocalUrl(value: string | undefined, fallback: string): URL {
  const url = new URL(value || fallback);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Engine URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Engine URL must not contain credentials or query data.");
  }
  return url;
}

async function isReachable(url: URL, pathName: string): Promise<Response | null> {
  try {
    return await fetch(new URL(pathName, url), {
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch {
    return null;
  }
}

async function checkOllama(): Promise<StudioEngine> {
  const model = process.env.STUDIO_OLLAMA_MODEL?.trim();
  let url: URL;
  try {
    url = configuredLocalUrl(process.env.STUDIO_OLLAMA_URL, DEFAULT_OLLAMA_URL);
  } catch {
    return {
      id: "ollama",
      name: "Ollama language model",
      local: true,
      configured: false,
      available: false,
      detail: "STUDIO_OLLAMA_URL must be a valid local Ollama HTTP address.",
    };
  }

  const response = await isReachable(url, "/api/tags");
  if (!response?.ok) {
    return {
      id: "ollama",
      name: "Ollama language model",
      local: true,
      configured: Boolean(model),
      available: false,
      detail: `Ollama is not reachable. Start Ollama at ${url.origin}.`,
    };
  }

  if (!model) {
    return {
      id: "ollama",
      name: "Ollama language model",
      local: true,
      configured: false,
      available: true,
      detail:
        "Ollama is reachable, but STUDIO_OLLAMA_MODEL is not set. No model was downloaded or selected.",
    };
  }

  try {
    const body = (await response.json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };
    const models = body.models ?? [];
    const installed = models.some((entry) =>
      [entry.name, entry.model].some(
        (candidate) =>
          candidate === model ||
          (typeof candidate === "string" &&
            candidate.split(":")[0] === model.split(":")[0] &&
            !model.includes(":")),
      ),
    );
    return {
      id: "ollama",
      name: "Ollama language model",
      local: true,
      configured: installed,
      available: true,
      detail: installed
        ? `Ollama is reachable and the configured model (${model}) is installed. This confirms service/model availability, not generated-output quality.`
        : `Ollama is reachable, but the configured model (${model}) is not installed.`,
    };
  } catch {
    return {
      id: "ollama",
      name: "Ollama language model",
      local: true,
      configured: false,
      available: false,
      detail: "Ollama returned an unreadable model list.",
    };
  }
}

async function checkComfyUI(): Promise<StudioEngine> {
  let url: URL;
  try {
    url = configuredLocalUrl(process.env.STUDIO_COMFY_URL, DEFAULT_COMFY_URL);
  } catch {
    return {
      id: "comfyui",
      name: "ComfyUI image/video",
      local: true,
      configured: false,
      available: false,
      detail: "STUDIO_COMFY_URL must be a valid local ComfyUI HTTP address.",
    };
  }
  const response = await isReachable(url, "/system_stats");
  const imageWorkflow = process.env.STUDIO_COMFY_IMAGE_WORKFLOW;
  const videoWorkflow = process.env.STUDIO_COMFY_VIDEO_WORKFLOW;
  if (!response?.ok) {
    return {
      id: "comfyui",
      name: "ComfyUI image/video",
      local: true,
      configured: Boolean(imageWorkflow || videoWorkflow),
      available: false,
      detail: `ComfyUI is not reachable. Start it at ${url.origin}.`,
    };
  }
  const promptNodeId = process.env.STUDIO_COMFY_PROMPT_NODE_ID?.trim();
  const videoPromptNodeId = process.env.STUDIO_COMFY_VIDEO_PROMPT_NODE_ID?.trim() || promptNodeId;
  const imageReady = Boolean(imageWorkflow && promptNodeId);
  const videoReady = Boolean(videoWorkflow && videoPromptNodeId);
  const configured = imageReady || videoReady;
  return {
    id: "comfyui",
    name: videoReady ? "ComfyUI image/video generation" : "ComfyUI image generation",
    local: true,
    configured,
    available: configured,
    detail: videoReady
      ? "ComfyUI is reachable and a video workflow plus prompt node are configured. Each generated clip is validated when a video job runs; model quality and memory compatibility are not inferred."
      : imageReady
        ? "ComfyUI is reachable and the still-image workflow plus prompt node are configured. Actual output is validated during a video job."
        : videoWorkflow
          ? "ComfyUI video workflow is set, but STUDIO_COMFY_VIDEO_PROMPT_NODE_ID or STUDIO_COMFY_PROMPT_NODE_ID must identify an inputs.text prompt node."
          : imageWorkflow
            ? "ComfyUI is reachable, but STUDIO_COMFY_PROMPT_NODE_ID must identify the positive prompt node with inputs.text."
            : "ComfyUI is reachable, but no image or video workflow is configured. Models are never downloaded automatically.",
  };
}

async function checkFfmpeg(): Promise<StudioEngine> {
  const executable = process.env.STUDIO_FFMPEG_BIN || "ffmpeg";
  return new Promise((resolve) => {
    const child = spawn(executable, ["-version"], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        id: "ffmpeg",
        name: "FFmpeg media tools",
        local: true,
        configured: true,
        available: false,
        detail: "FFmpeg did not respond within 2.5 seconds.",
      });
    }, ENGINE_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve({
        id: "ffmpeg",
        name: "FFmpeg media tools",
        local: true,
        configured: false,
        available: false,
        detail: "FFmpeg is not installed or STUDIO_FFMPEG_BIN is invalid.",
      });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({
        id: "ffmpeg",
        name: "FFmpeg media tools",
        local: true,
        configured: true,
        available: code === 0,
        detail:
          code === 0
            ? "FFmpeg is installed and ready for storyboard-card or ComfyUI-still MP4 rendering."
            : "FFmpeg did not pass its version check.",
      });
    });
  });
}

async function checkPiper(): Promise<StudioEngine> {
  const binary = process.env.STUDIO_PIPER_BIN;
  const model = process.env.STUDIO_PIPER_MODEL;
  if (!binary || !model) {
    return {
      id: "piper",
      name: "Piper speech synthesis",
      local: true,
      configured: false,
      available: false,
      detail:
        "Set STUDIO_PIPER_BIN and STUDIO_PIPER_MODEL to use local speech synthesis. No voice model is included.",
    };
  }
  try {
    await Promise.all([
      access(binary, constants.X_OK),
      access(path.resolve(model), constants.R_OK),
    ]);
    return {
      id: "piper",
      name: "Piper speech synthesis",
      local: true,
      configured: true,
      available: true,
      detail:
        "Piper executable and voice model files are readable and ready for local narration. Quality and language support depend on the chosen model.",
    };
  } catch {
    return {
      id: "piper",
      name: "Piper speech synthesis",
      local: true,
      configured: true,
      available: false,
      detail: "The configured Piper executable or voice model cannot be read.",
    };
  }
}

export async function getStudioEngineHealth(): Promise<StudioEngine[]> {
  const results = await Promise.all([
    checkOllama(),
    checkComfyUI(),
    checkFfmpeg(),
    checkPiper(),
  ]);
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  results.push({
    id: "youtube",
    name: "YouTube Data API",
    local: false,
    configured: Boolean(clientId && clientSecret),
    available: Boolean(clientId && clientSecret),
    detail:
      clientId && clientSecret
        ? "OAuth app credentials are configured. No channel has been connected."
        : "Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in server-side environment secrets to enable channel OAuth.",
  });
  return results;
}

export function getOllamaConfig(): { url: URL; model: string } {
  const model = process.env.STUDIO_OLLAMA_MODEL?.trim();
  if (!model) {
    throw new Error(
      "Local story generation is not configured. Set STUDIO_OLLAMA_MODEL after installing an appropriately licensed model.",
    );
  }
  const url = configuredLocalUrl(process.env.STUDIO_OLLAMA_URL, DEFAULT_OLLAMA_URL);
  return { url, model };
}

export async function probeOllamaModel(): Promise<boolean> {
  try {
    const { url, model } = getOllamaConfig();
    const response = await isReachable(url, "/api/tags");
    if (!response?.ok) return false;
    const body = (await response.json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };
    return (body.models ?? []).some((entry) =>
      [entry.name, entry.model].includes(model),
    );
  } catch (error) {
    logger.debug({ err: error }, "Ollama model probe failed");
    return false;
  }
}

export async function readComfyWorkflow(pathname: string): Promise<unknown> {
  const workflow = JSON.parse(await readFile(path.resolve(pathname), "utf8")) as unknown;
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    throw new Error("Configured ComfyUI workflow must be a JSON object.");
  }
  return workflow;
}

import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  pool,
  studioCharactersTable,
  studioJobsTable,
  studioProjectsTable,
  studioScenesTable,
} from "@workspace/db";
import type { StudioJob } from "@workspace/api-zod";
import { getOllamaConfig } from "./studioEngines";
import { renderStudioVideo } from "./studioRenderer";
import { logger } from "./logger";
import { fitSceneDurations, getRetryPlan, planScriptScenes } from "./scenePlanning";

type ClaimedJob = {
  id: string;
  project_id: string;
  type: string;
  attempt: number;
  max_attempts: number;
  payload: Record<string, unknown>;
};

const activeControllers = new Map<string, AbortController>();
let workerStarted = false;
let isClaiming = false;

class PermanentJobError extends Error {}

const storyResultSchema = z.object({
  title: z.string().min(2).max(160),
  logline: z.string().min(5).max(1000),
  script: z.string().min(500).max(100000),
});

const sceneResultSchema = z.object({
  scenes: z
    .array(
      z.object({
        title: z.string().min(1).max(160),
        durationSeconds: z.number().int().min(1).max(600),
        action: z.string().max(5000),
        dialogue: z.string().max(10000),
        narration: z.string().max(10000),
        background: z.string().max(2000),
        camera: z.string().max(2000),
        visualPrompt: z.string().max(5000),
        audioNotes: z.string().max(2000),
        transition: z.string().max(500).optional(),
      }),
    )
    .min(3)
    .max(80),
});

function jsonFromModelResponse(value: string): unknown {
  const withoutFence = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const firstObject = withoutFence.indexOf("{");
  const lastObject = withoutFence.lastIndexOf("}");
  if (firstObject < 0 || lastObject <= firstObject) {
    throw new PermanentJobError(
      "The local model did not return the required structured result. Review the model and retry.",
    );
  }
  try {
    return JSON.parse(withoutFence.slice(firstObject, lastObject + 1)) as unknown;
  } catch {
    throw new PermanentJobError(
      "The local model returned invalid JSON. Review the model and retry.",
    );
  }
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

async function updateProgress(
  id: string,
  progress: number,
  message: string,
): Promise<void> {
  await db
    .update(studioJobsTable)
    .set({ progress, message, updatedAt: new Date() })
    .where(eq(studioJobsTable.id, id));
}

async function ensureNotCancelled(
  id: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new PermanentJobError("Generation was cancelled.");
  const [job] = await db
    .select({ status: studioJobsTable.status })
    .from(studioJobsTable)
    .where(eq(studioJobsTable.id, id))
    .limit(1);
  if (!job || job.status === "cancelled") {
    throw new PermanentJobError("Generation was cancelled.");
  }
}

async function askOllama(
  prompt: string,
  signal: AbortSignal,
  maxTokens: number,
): Promise<string> {
  let config: ReturnType<typeof getOllamaConfig>;
  try {
    config = getOllamaConfig();
  } catch (error) {
    throw new PermanentJobError(
      error instanceof Error
        ? error.message
        : "Local story generation is not configured.",
    );
  }

  const tags = await fetch(new URL("/api/tags", config.url), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    headers: { Accept: "application/json" },
  }).catch(() => null);
  if (!tags?.ok) {
    throw new PermanentJobError(
      "Ollama is not reachable. Start the local engine and retry.",
    );
  }
  const tagsData = (await tags.json()) as {
    models?: Array<{ name?: string; model?: string }>;
  };
  if (!(tagsData.models ?? []).some((entry) =>
    [entry.name, entry.model].includes(config.model),
  )) {
    throw new PermanentJobError(
      `The configured Ollama model (${config.model}) is not installed. No model was downloaded automatically.`,
    );
  }

  const timeoutMs = Math.min(
    600_000,
    Math.max(30_000, Number(process.env.STUDIO_OLLAMA_TIMEOUT_MS) || 420_000),
  );
  const response = await fetch(new URL("/api/generate", config.url), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      model: config.model,
      prompt,
      stream: false,
      format: "json",
      options: { num_ctx: 8192, num_predict: maxTokens, temperature: 0.75 },
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  }).catch((error: unknown) => {
    if (signal.aborted) {
      throw new PermanentJobError("Generation was cancelled.");
    }
    throw new Error(
      error instanceof Error
        ? `Local inference request failed: ${error.message.slice(0, 180)}`
        : "Local inference request failed.",
    );
  });

  if (!response.ok) {
    throw new Error(
      `Ollama returned HTTP ${response.status}. Check the local model service and retry.`,
    );
  }
  const body = (await response.json()) as { response?: string };
  if (typeof body.response !== "string" || !body.response.trim()) {
    throw new PermanentJobError("Ollama returned an empty generation.");
  }
  return body.response;
}

async function runStoryJob(job: ClaimedJob, signal: AbortSignal): Promise<void> {
  const payload = z
    .object({
      idea: z.string().min(1).max(5000),
      language: z.enum(["Hindi", "Hinglish", "English"]),
      genre: z.string().min(1).max(80),
      targetMinutes: z.union([
        z.literal(1),
        z.literal(3),
        z.literal(5),
        z.literal(6),
        z.literal(7),
        z.literal(8),
        z.literal(10),
      ]),
      visualStyle: z.enum(["2d", "3d-cartoon", "anime", "cinematic"]),
    })
    .safeParse(job.payload);
  if (!payload.success) {
    throw new PermanentJobError("Saved story-generation settings are invalid.");
  }
  const data = payload.data;
  const targetWords = data.targetMinutes * 120;
  await updateProgress(job.id, 12, "Checking the configured local model");
  await ensureNotCancelled(job.id, signal);

  const languageDirection =
    data.language === "Hindi"
      ? "Write natural contemporary Hindi in Devanagari."
      : data.language === "Hinglish"
        ? "Write natural Indian Hinglish using Latin script, with dialogue that sounds spoken rather than transliterated Hindi."
        : "Write natural contemporary English.";
  const prompt = [
    "Create an original, complete narrated story script for a YouTube video.",
    "Do not copy, continue, imitate, or name living creators or copyrighted characters.",
    `Premise supplied by the creator: ${data.idea}`,
    `Genre: ${data.genre}. Visual direction for future scenes: ${data.visualStyle}.`,
    `Language: ${languageDirection}`,
    `Target duration: ${data.targetMinutes} minutes at about 120 whitespace-separated spoken words per minute. Aim for ${targetWords} words in the script field. This is a genuine long-form script, not a synopsis.`,
    "Give the script a clear opening hook, sceneable action, distinct original characters, natural dialogue/narration, emotional progression, and a deliberate ending.",
    "Return one JSON object with exactly these string fields: title, logline, script.",
    "The script field must contain only the performable script, with speaker labels and light scene cues where useful. Do not wrap it in markdown.",
  ].join("\n");
  await updateProgress(job.id, 25, "Generating the original script on the local model");
  const raw = await askOllama(prompt, signal, Math.min(targetWords * 3, 8000));
  await ensureNotCancelled(job.id, signal);
  const result = storyResultSchema.safeParse(jsonFromModelResponse(raw));
  if (!result.success) {
    throw new PermanentJobError(
      "The local model did not produce a valid title, logline and script. Check its output format and retry.",
    );
  }
  const words = wordCount(result.data.script);
  const minimumWords = Math.floor(targetWords * 0.65);
  if (words < minimumWords) {
    throw new PermanentJobError(
      `The local model returned ${words} script words; at least ${minimumWords} are required to meet the ${data.targetMinutes}-minute target. Nothing was marked complete.`,
    );
  }

  await updateProgress(job.id, 88, "Saving and validating the generated script");
  await ensureNotCancelled(job.id, signal);
  await db.transaction(async (tx) => {
    const [completed] = await tx
      .update(studioJobsTable)
      .set({
        status: "succeeded",
        progress: 100,
        message: `Script saved and checked: ${words} words, approximately ${(words / 120).toFixed(1)} minutes at 120 words/minute.`,
        error: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(studioJobsTable.id, job.id),
          eq(studioJobsTable.status, "running"),
        ),
      )
      .returning({ id: studioJobsTable.id });
    if (!completed) {
      throw new PermanentJobError("Generation was cancelled before saving.");
    }
    await tx
      .update(studioProjectsTable)
      .set({
        title: result.data.title,
        idea: data.idea,
        language: data.language,
        genre: data.genre,
        targetMinutes: data.targetMinutes,
        visualStyle: data.visualStyle,
        scriptText: result.data.script,
        status: "script_ready",
        updatedAt: new Date(),
      })
      .where(eq(studioProjectsTable.id, job.project_id));
  });
}

async function runSceneBreakdownJob(
  job: ClaimedJob,
  signal: AbortSignal,
): Promise<void> {
  const [project] = await db
    .select()
    .from(studioProjectsTable)
    .where(eq(studioProjectsTable.id, job.project_id))
    .limit(1);
  if (!project?.scriptText.trim()) {
    throw new PermanentJobError(
      "Save a script before generating the scene breakdown.",
    );
  }
  await updateProgress(job.id, 15, "Checking the configured local model");
  await ensureNotCancelled(job.id, signal);
  const prompt = [
    "Turn this creator-owned video script into a practical scene breakdown.",
    "Return one JSON object with a single property, scenes: an array.",
    "Every scene must have: title (string), durationSeconds (integer), action (string), dialogue (string), narration (string), background (string), camera (string), visualPrompt (string), audioNotes (string).",
    `Create enough scenes to cover roughly ${project.targetMinutes * 60} seconds. Total duration should be within 10% of that target.`,
    `Use ${project.language} for spoken text. Preserve names and story facts from the script; do not add characters. Keep each scene visually actionable.`,
    "Return JSON only; do not use markdown fences.",
    `SCRIPT:\n${project.scriptText}`,
  ].join("\n\n");
  await updateProgress(job.id, 25, "Breaking the saved script into scenes");
  const raw = await askOllama(
    prompt,
    signal,
    Math.min(project.targetMinutes * 600, 6000),
  );
  await ensureNotCancelled(job.id, signal);
  const parsed = sceneResultSchema.safeParse(jsonFromModelResponse(raw));
  if (!parsed.success) {
    throw new PermanentJobError(
      "The local model did not return a valid scene breakdown. No scenes were saved.",
    );
  }
  const targetDuration = project.targetMinutes * 60;
  const scenes = fitSceneDurations(
    parsed.data.scenes.map((scene) => ({
      ...scene,
      transition: scene.transition || "cut",
    })),
    targetDuration,
  );
  const duration = scenes.reduce((total, scene) => total + scene.durationSeconds, 0);

  await updateProgress(job.id, 88, "Saving the scene breakdown");
  await ensureNotCancelled(job.id, signal);
  await db.transaction(async (tx) => {
    const [completed] = await tx
      .update(studioJobsTable)
      .set({
        status: "succeeded",
        progress: 100,
        message: `Saved ${parsed.data.scenes.length} scenes totaling ${duration} seconds.`,
        error: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(studioJobsTable.id, job.id),
          eq(studioJobsTable.status, "running"),
        ),
      )
      .returning({ id: studioJobsTable.id });
    if (!completed) {
      throw new PermanentJobError("Generation was cancelled before saving.");
    }
    await tx
      .delete(studioScenesTable)
      .where(eq(studioScenesTable.projectId, project.id));
    await tx.insert(studioScenesTable).values(
      scenes.map((scene, index) => ({
        projectId: project.id,
        sequence: index + 1,
        ...scene,
      })),
    );
    await tx
      .update(studioProjectsTable)
      .set({ status: "scenes_ready", updatedAt: new Date() })
      .where(eq(studioProjectsTable.id, project.id));
  });
}

async function runFullVideoJob(
  job: ClaimedJob,
  signal: AbortSignal,
): Promise<void> {
  const payload = z
    .object({
      aspectRatio: z.enum(["16:9", "9:16"]),
      characterIds: z.array(z.string().uuid()).max(30).default([]),
    })
    .safeParse(job.payload);
  if (!payload.success) {
    throw new PermanentJobError("Saved full-video settings are invalid.");
  }
  const [project] = await db
    .select()
    .from(studioProjectsTable)
    .where(eq(studioProjectsTable.id, job.project_id))
    .limit(1);
  if (!project?.scriptText.trim()) {
    throw new PermanentJobError("Save a complete script before generating a video.");
  }
  await updateProgress(job.id, 8, "Preparing the script and character references");
  await ensureNotCancelled(job.id, signal);

  const characters = payload.data.characterIds.length
    ? await db
        .select()
        .from(studioCharactersTable)
        .where(inArray(studioCharactersTable.id, payload.data.characterIds))
    : [];
  if (characters.length !== payload.data.characterIds.length) {
    throw new PermanentJobError(
      "One or more selected character profiles no longer exist. No storyboard was saved.",
    );
  }
  const characterContinuity = characters.map((character) =>
    [
      `${character.name}:`,
      character.appearance || character.description,
      character.visualStyle && `Visual style: ${character.visualStyle}.`,
    ]
      .filter(Boolean)
      .join(" "),
  );
  const scenes = planScriptScenes({
    script: project.scriptText,
    targetMinutes: project.targetMinutes,
    visualStyle: project.visualStyle,
    characterContinuity,
  });
  const exactDuration = scenes.reduce(
    (total, scene) => total + scene.durationSeconds,
    0,
  );

  await updateProgress(job.id, 18, "Automatically splitting the script into timed scenes");
  await ensureNotCancelled(job.id, signal);
  await db.transaction(async (tx) => {
    const [activeJob] = await tx
      .update(studioJobsTable)
      .set({
        progress: 25,
        message: `Storyboard draft saved (${scenes.length} scenes, ${exactDuration} seconds, ${payload.data.aspectRatio}). Checking media engines.`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(studioJobsTable.id, job.id),
          eq(studioJobsTable.status, "running"),
        ),
      )
      .returning({ id: studioJobsTable.id });
    if (!activeJob) {
      throw new PermanentJobError("Generation was cancelled before the storyboard was saved.");
    }
    await tx
      .delete(studioScenesTable)
      .where(eq(studioScenesTable.projectId, project.id));
    await tx.insert(studioScenesTable).values(
      scenes.map((scene, index) => ({
        projectId: project.id,
        sequence: index + 1,
        ...scene,
      })),
    );
    await tx
      .update(studioProjectsTable)
      .set({ status: "scenes_ready", updatedAt: new Date() })
      .where(eq(studioProjectsTable.id, project.id));
  });

  const renderResult = await renderStudioVideo({
    projectId: project.id,
    aspectRatio: payload.data.aspectRatio,
    scenes: scenes.map((scene, index) => ({ ...scene, sequence: index + 1 })),
    signal,
    onProgress: async (completed, total, message) => {
      await ensureNotCancelled(job.id, signal);
      await updateProgress(job.id, 25 + Math.floor((completed / total) * 65), message);
    },
  });
  await ensureNotCancelled(job.id, signal);
  const summary = renderResult.mode === "comfyui-stills"
    ? "MP4 rendered using configured ComfyUI scene artwork."
    : "Storyboard-card MP4 rendered; image generation is not configured.";
  const message = [
    summary,
    renderResult.hasNarration ? "Local Piper narration included." : "No narration audio was added.",
    "Output: " + renderResult.outputPath,
    ...renderResult.warnings,
  ].join(" ").slice(0, 2_000);
  await db.transaction(async (tx) => {
    const [completed] = await tx
      .update(studioJobsTable)
      .set({
        status: "succeeded",
        progress: 100,
        message,
        error: null,
        payload: {
          ...job.payload,
          outputFile: renderResult.outputPath.split(/[\\/]/u).pop(),
          renderMode: renderResult.mode,
          hasNarration: renderResult.hasNarration,
          warnings: renderResult.warnings,
        },
        updatedAt: new Date(),
      })
      .where(and(eq(studioJobsTable.id, job.id), eq(studioJobsTable.status, "running")))
      .returning({ id: studioJobsTable.id });
    if (!completed) throw new PermanentJobError("Generation was cancelled before the MP4 was saved.");
    await tx.update(studioProjectsTable).set({ status: "video_ready", updatedAt: new Date() }).where(eq(studioProjectsTable.id, project.id));
  });
}

async function processJob(job: ClaimedJob): Promise<void> {
  const controller = new AbortController();
  activeControllers.set(job.id, controller);
  try {
    if (job.type === "story") {
      await runStoryJob(job, controller.signal);
    } else if (job.type === "scene_breakdown") {
      await runSceneBreakdownJob(job, controller.signal);
    } else if (job.type === "full_video") {
      await runFullVideoJob(job, controller.signal);
    } else {
      throw new PermanentJobError(
        `The ${job.type} worker is not implemented in this build. No output was created.`,
      );
    }
  } catch (error) {
    const [current] = await db
      .select({
        status: studioJobsTable.status,
        progress: studioJobsTable.progress,
      })
      .from(studioJobsTable)
      .where(eq(studioJobsTable.id, job.id))
      .limit(1);
    if (controller.signal.aborted || current?.status === "cancelled") {
      await db
        .update(studioJobsTable)
        .set({
          status: "cancelled",
          progress: 0,
          message: "Cancelled before the result was saved.",
          error: null,
          updatedAt: new Date(),
        })
        .where(eq(studioJobsTable.id, job.id));
      return;
    }

    const message =
      error instanceof Error
        ? error.message.slice(0, 500)
        : "Generation failed for an unknown reason.";
    const retryPlan = getRetryPlan(
      error instanceof PermanentJobError,
      job.attempt,
      job.max_attempts,
    );
    await db
      .update(studioJobsTable)
      .set({
        status: retryPlan.retry ? "queued" : "failed",
        progress: retryPlan.retry ? 0 : (current?.progress ?? 0),
        availableAt: new Date(Date.now() + retryPlan.delayMs),
        message: retryPlan.retry
          ? `Temporary error. Retrying in ${retryPlan.delayMs / 1000} seconds.`
          : message,
        error: message,
        updatedAt: new Date(),
      })
      .where(eq(studioJobsTable.id, job.id));
    logger.error(
      {
        jobId: job.id,
        projectId: job.project_id,
        attempt: job.attempt,
        retry: retryPlan.retry,
      },
      "Studio background job failed",
    );
  } finally {
    activeControllers.delete(job.id);
  }
}

async function claimNextJob(): Promise<ClaimedJob | null> {
  const result = await pool.query<ClaimedJob>(`
    UPDATE studio_jobs
    SET status = 'running',
        attempt = attempt + 1,
        message = 'Starting local processing',
        updated_at = now()
    WHERE id = (
      SELECT id
      FROM studio_jobs
      WHERE status = 'queued'
        AND available_at <= now()
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, project_id, type, attempt, max_attempts, payload
  `);
  return result.rows[0] ?? null;
}

async function pollQueue(): Promise<void> {
  if (isClaiming) return;
  isClaiming = true;
  try {
    const job = await claimNextJob();
    if (job) await processJob(job);
  } catch (error) {
    logger.error({ err: error }, "Studio job queue polling failed");
  } finally {
    isClaiming = false;
  }
}

export async function cancelRunningStudioJob(id: string): Promise<void> {
  const controller = activeControllers.get(id);
  if (controller) controller.abort();
}

export async function startStudioWorker(): Promise<void> {
  if (workerStarted) return;
  workerStarted = true;
  try {
    await db
      .update(studioJobsTable)
      .set({
        status: "queued",
        progress: 0,
        message: "Resuming after server restart",
        updatedAt: new Date(),
      })
      .where(eq(studioJobsTable.status, "running"));
  } catch (error) {
    workerStarted = false;
    logger.error({ err: error }, "Could not recover interrupted studio jobs");
    return;
  }
  const interval = Math.min(
    10_000,
    Math.max(1_000, Number(process.env.STUDIO_WORKER_POLL_MS) || 2_000),
  );
  const timer = setInterval(() => void pollQueue(), interval);
  timer.unref();
  void pollQueue();
  logger.info({ interval }, "Studio background worker started");
}

export async function queueStudioJob(
  projectId: string,
  type: "story" | "scene_breakdown" | "full_video",
  payload: Record<string, unknown>,
): Promise<StudioJob> {
  const [job] = await db
    .insert(studioJobsTable)
    .values({
      projectId,
      type,
      payload,
      status: "queued",
      progress: 0,
      attempt: 0,
      maxAttempts: 3,
      message: "Waiting in queue",
    })
    .returning();
  if (!job) throw new Error("Could not save the job.");
  return {
    id: job.id,
    projectId: job.projectId,
    type: job.type as StudioJob["type"],
    status: job.status as StudioJob["status"],
    progress: job.progress,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    message: job.message,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export async function retryFailedStudioJob(id: string): Promise<StudioJob | null> {
  const [job] = await db
    .update(studioJobsTable)
    .set({
      status: "queued",
      progress: 0,
      attempt: 0,
      availableAt: new Date(),
      message: "Manually queued for retry",
      error: null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(studioJobsTable.id, id), eq(studioJobsTable.status, "failed")),
    )
    .returning();
  if (!job) return null;
  return {
    id: job.id,
    projectId: job.projectId,
    type: job.type as StudioJob["type"],
    status: "queued",
    progress: 0,
    attempt: 0,
    maxAttempts: job.maxAttempts,
    message: job.message,
    error: null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function getActiveStudioJobs() {
  return db
    .select()
    .from(studioJobsTable)
    .where(eq(studioJobsTable.status, "running"))
    .orderBy(desc(studioJobsTable.createdAt));
}

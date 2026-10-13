import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  CancelStudioJobParams,
  CreateProjectSceneBody,
  CreateProjectSceneParams,
  CreateSceneBreakdownJobParams,
  CreateStudioCharacterBody,
  CreateStudioProjectBody,
  CreateStoryGenerationJobParams,
  CreateStoryGenerationJobBody,
  DeleteStudioCharacterParams,
  DeleteStudioProjectParams,
  DeleteStudioSceneParams,
  GetStudioProjectParams,
  ListProjectScenesParams,
  ListStudioJobsQueryParams,
  RestoreStudioBackupBody,
  RetryStudioJobParams,
  StartStudioFullVideoBody,
  StartStudioFullVideoResponse,
  UpdateStudioProjectBody,
  UpdateStudioProjectParams,
  UpdateStudioSceneBody,
  UpdateStudioSceneParams,
  UpdateStudioCharacterBody,
  UpdateStudioCharacterParams,
} from "@workspace/api-zod";
import {
  db,
  studioCharactersTable,
  studioJobsTable,
  studioProjectsTable,
  studioScenesTable,
} from "@workspace/db";
import { requireStudioOwner } from "../middlewares/studioOwner";
import {
  cancelRunningStudioJob,
  queueStudioJob,
  retryFailedStudioJob,
} from "../lib/studioWorker";
import { getStudioEngineHealth } from "../lib/studioEngines";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { studioVideoPath } from "../lib/studioRenderer";
import {
  beginYouTubeOAuth,
  disconnectYouTube,
  finishYouTubeOAuth,
  youtubeAnalytics,
  youtubeStatus,
} from "../lib/studioYoutube";

const router: IRouter = Router();
router.use(requireStudioOwner);
const generationRequests = new Map<string, number[]>();

const badRequest = (res: Response, error: string) =>
  res.status(400).json({ error });
const notFound = (res: Response, message: string) =>
  res.status(404).json({ error: message });

function projectDto(row: typeof studioProjectsTable.$inferSelect) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sceneDto(row: typeof studioScenesTable.$inferSelect) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function characterDto(row: typeof studioCharactersTable.$inferSelect) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function jobDto(row: typeof studioJobsTable.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    type: row.type,
    status: row.status,
    progress: row.progress,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    message: row.message,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function reportError(req: Request, res: Response, error: unknown): void {
  req.log.error({ err: error }, "Studio API request failed");
  if (!res.headersSent) {
    res.status(500).json({ error: "The studio could not complete that request." });
  }
}

async function requireProject(id: string) {
  const [project] = await db
    .select()
    .from(studioProjectsTable)
    .where(eq(studioProjectsTable.id, id))
    .limit(1);
  return project ?? null;
}

async function canQueueProjectJob(
  projectId: string,
): Promise<{ allowed: boolean; message?: string }> {
  const [pendingProject, pendingTotal] = await Promise.all([
    db
      .select({ total: count() })
      .from(studioJobsTable)
      .where(
        and(
          eq(studioJobsTable.projectId, projectId),
          inArray(studioJobsTable.status, ["queued", "running"]),
        ),
      ),
    db
      .select({ total: count() })
      .from(studioJobsTable)
      .where(inArray(studioJobsTable.status, ["queued", "running"])),
  ]);
  if ((pendingProject[0]?.total ?? 0) >= 2) {
    return {
      allowed: false,
      message: "This project already has two active jobs. Wait for one to finish.",
    };
  }
  if ((pendingTotal[0]?.total ?? 0) >= 4) {
    return {
      allowed: false,
      message: "The studio queue is full. Wait for an active job to finish.",
    };
  }
  return { allowed: true };
}

function generationRateAllowed(userId: string): boolean {
  const now = Date.now();
  const recent = (generationRequests.get(userId) ?? []).filter(
    (timestamp) => now - timestamp < 60_000,
  );
  if (recent.length >= 3) {
    generationRequests.set(userId, recent);
    return false;
  }
  recent.push(now);
  generationRequests.set(userId, recent);
  return true;
}

router.get("/studio/overview", async (req, res) => {
  try {
    const [projectCount, activeJobs, failedJobs, sceneCount, recentJobs] =
      await Promise.all([
        db.select({ total: count() }).from(studioProjectsTable),
        db
          .select({ total: count() })
          .from(studioJobsTable)
          .where(inArray(studioJobsTable.status, ["queued", "running"])),
        db
          .select({ total: count() })
          .from(studioJobsTable)
          .where(eq(studioJobsTable.status, "failed")),
        db.select({ total: count() }).from(studioScenesTable),
        db
          .select()
          .from(studioJobsTable)
          .orderBy(desc(studioJobsTable.createdAt))
          .limit(8),
      ]);
    res.json({
      projectCount: projectCount[0]?.total ?? 0,
      activeJobs: activeJobs[0]?.total ?? 0,
      failedJobs: failedJobs[0]?.total ?? 0,
      scenes: sceneCount[0]?.total ?? 0,
      recentJobs: recentJobs.map(jobDto),
    });
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/studio/projects", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(studioProjectsTable)
      .orderBy(desc(studioProjectsTable.updatedAt));
    res.json(rows.map(projectDto));
  } catch (error) {
    reportError(req, res, error);
  }
});

router.post("/studio/videos/generate", async (req, res) => {
  const body = StartStudioFullVideoBody.safeParse(req.body);
  if (!body.success) {
    badRequest(res, body.error.issues[0]?.message ?? "Invalid video settings.");
    return;
  }
  try {
    const userId = getAuth(req).userId;
    if (!userId || !generationRateAllowed(userId)) {
      res.status(429).json({
        error: "Generation is limited to three submitted jobs per minute.",
      });
      return;
    }
    const [active] = await db
      .select({ total: count() })
      .from(studioJobsTable)
      .where(inArray(studioJobsTable.status, ["queued", "running"]));
    if ((active?.total ?? 0) >= 4) {
      res.status(429).json({
        error: "The studio queue is full. Wait for an active job to finish.",
      });
      return;
    }
    const characterIds = body.data.characterIds ?? [];
    if (characterIds.length) {
      const found = await db
        .select({ id: studioCharactersTable.id })
        .from(studioCharactersTable)
        .where(inArray(studioCharactersTable.id, characterIds));
      if (found.length !== characterIds.length) {
        badRequest(res, "One or more selected character profiles do not exist.");
        return;
      }
    }
    const result = await db.transaction(async (tx) => {
      const [project] = await tx
        .insert(studioProjectsTable)
        .values({
          title: body.data.title,
          idea: body.data.idea ?? "",
          language: body.data.language,
          genre: body.data.genre,
          targetMinutes: body.data.targetMinutes,
          visualStyle: body.data.visualStyle,
          scriptText: body.data.scriptText,
          status: "script_ready",
        })
        .returning();
      if (!project) throw new Error("Project insert returned no row.");
      const [job] = await tx
        .insert(studioJobsTable)
        .values({
          projectId: project.id,
          type: "full_video",
          status: "queued",
          progress: 0,
          attempt: 0,
          maxAttempts: 3,
          message: "Queued. The script will be split into scenes automatically.",
          payload: {
            aspectRatio: body.data.aspectRatio,
            characterIds,
          },
        })
        .returning();
      if (!job) throw new Error("Job insert returned no row.");
      return { project, job };
    });
    res
      .status(202)
      .json(
        StartStudioFullVideoResponse.parse({
          project: projectDto(result.project),
          job: jobDto(result.job),
        }),
      );
  } catch (error) {
    reportError(req, res, error);
  }
});

router.post("/studio/projects", async (req, res) => {
  try {
    const parsed = CreateStudioProjectBody.safeParse(req.body);
    if (!parsed.success) {
      badRequest(res, parsed.error.issues[0]?.message ?? "Invalid project details.");
      return;
    }
    const [created] = await db
      .insert(studioProjectsTable)
      .values({
        ...parsed.data,
        scriptText: parsed.data.scriptText ?? "",
        status: "concept",
      })
      .returning();
    if (!created) throw new Error("Project insert returned no row.");
    res.status(201).json(projectDto(created));
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/studio/projects/:id", async (req, res) => {
  const params = GetStudioProjectParams.safeParse(req.params);
  if (!params.success) {
    badRequest(res, "Invalid project ID.");
    return;
  }
  try {
    const project = await requireProject(params.data.id);
    if (!project) {
      notFound(res, "Project not found.");
      return;
    }
    res.json(projectDto(project));
  } catch (error) {
    reportError(req, res, error);
  }
});

router.patch("/studio/projects/:id", async (req, res) => {
  const params = UpdateStudioProjectParams.safeParse(req.params);
  const body = UpdateStudioProjectBody.safeParse(req.body);
  if (!params.success || !body.success) {
    badRequest(
      res,
      !body.success
        ? body.error.issues[0]?.message ?? "Invalid project details."
        : "Invalid project ID.",
    );
    return;
  }
  try {
    const [updated] = await db
      .update(studioProjectsTable)
      .set({ ...body.data, updatedAt: new Date() })
      .where(eq(studioProjectsTable.id, params.data.id))
      .returning();
    if (!updated) {
      notFound(res, "Project not found.");
      return;
    }
    res.json(projectDto(updated));
  } catch (error) {
    reportError(req, res, error);
  }
});

router.delete("/studio/projects/:id", async (req, res) => {
  const params = DeleteStudioProjectParams.safeParse(req.params);
  if (!params.success) {
    badRequest(res, "Invalid project ID.");
    return;
  }
  try {
    const [deleted] = await db
      .delete(studioProjectsTable)
      .where(eq(studioProjectsTable.id, params.data.id))
      .returning({ id: studioProjectsTable.id });
    if (!deleted) {
      notFound(res, "Project not found.");
      return;
    }
    res.status(204).end();
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/studio/projects/:id/scenes", async (req, res) => {
  const params = ListProjectScenesParams.safeParse(req.params);
  if (!params.success) {
    badRequest(res, "Invalid project ID.");
    return;
  }
  try {
    if (!(await requireProject(params.data.id))) {
      notFound(res, "Project not found.");
      return;
    }
    const rows = await db
      .select()
      .from(studioScenesTable)
      .where(eq(studioScenesTable.projectId, params.data.id))
      .orderBy(asc(studioScenesTable.sequence));
    res.json(rows.map(sceneDto));
  } catch (error) {
    reportError(req, res, error);
  }
});

router.post("/studio/projects/:id/scenes", async (req, res) => {
  const params = CreateProjectSceneParams.safeParse(req.params);
  const body = CreateProjectSceneBody.safeParse(req.body);
  if (!params.success || !body.success) {
    badRequest(
      res,
      !body.success
        ? body.error.issues[0]?.message ?? "Invalid scene details."
        : "Invalid project ID.",
    );
    return;
  }
  try {
    if (!(await requireProject(params.data.id))) {
      notFound(res, "Project not found.");
      return;
    }
    let sequence = body.data.sequence;
    if (sequence === undefined) {
      const [lastScene] = await db
        .select({ sequence: studioScenesTable.sequence })
        .from(studioScenesTable)
        .where(eq(studioScenesTable.projectId, params.data.id))
        .orderBy(desc(studioScenesTable.sequence))
        .limit(1);
      sequence = (lastScene?.sequence ?? 0) + 1;
    }
    const [created] = await db
      .insert(studioScenesTable)
      .values({
        projectId: params.data.id,
        sequence,
        title: body.data.title,
        durationSeconds: body.data.durationSeconds,
        action: body.data.action ?? "",
        dialogue: body.data.dialogue ?? "",
        narration: body.data.narration ?? "",
        background: body.data.background ?? "",
        camera: body.data.camera ?? "",
        visualPrompt: body.data.visualPrompt ?? "",
        audioNotes: body.data.audioNotes ?? "",
      })
      .returning();
    if (!created) throw new Error("Scene insert returned no row.");
    res.status(201).json(sceneDto(created));
  } catch (error) {
    reportError(req, res, error);
  }
});

router.patch("/studio/scenes/:id", async (req, res) => {
  const params = UpdateStudioSceneParams.safeParse(req.params);
  const body = UpdateStudioSceneBody.safeParse(req.body);
  if (!params.success || !body.success) {
    badRequest(
      res,
      !body.success
        ? body.error.issues[0]?.message ?? "Invalid scene details."
        : "Invalid scene ID.",
    );
    return;
  }
  try {
    const [updated] = await db
      .update(studioScenesTable)
      .set({ ...body.data, updatedAt: new Date() })
      .where(eq(studioScenesTable.id, params.data.id))
      .returning();
    if (!updated) {
      notFound(res, "Scene not found.");
      return;
    }
    res.json(sceneDto(updated));
  } catch (error) {
    reportError(req, res, error);
  }
});

router.delete("/studio/scenes/:id", async (req, res) => {
  const params = DeleteStudioSceneParams.safeParse(req.params);
  if (!params.success) {
    badRequest(res, "Invalid scene ID.");
    return;
  }
  try {
    const [deleted] = await db
      .delete(studioScenesTable)
      .where(eq(studioScenesTable.id, params.data.id))
      .returning({ id: studioScenesTable.id });
    if (!deleted) {
      notFound(res, "Scene not found.");
      return;
    }
    res.status(204).end();
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/studio/characters", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(studioCharactersTable)
      .orderBy(asc(studioCharactersTable.name));
    res.json(rows.map(characterDto));
  } catch (error) {
    reportError(req, res, error);
  }
});

router.post("/studio/characters", async (req, res) => {
  try {
    const body = CreateStudioCharacterBody.safeParse(req.body);
    if (!body.success) {
      badRequest(res, body.error.issues[0]?.message ?? "Invalid character profile.");
      return;
    }
    const [created] = await db
      .insert(studioCharactersTable)
      .values({
        name: body.data.name,
        description: body.data.description ?? "",
        appearance: body.data.appearance ?? "",
        voiceNotes: body.data.voiceNotes ?? "",
        visualStyle: body.data.visualStyle ?? "",
      })
      .returning();
    if (!created) throw new Error("Character insert returned no row.");
    res.status(201).json(characterDto(created));
  } catch (error) {
    reportError(req, res, error);
  }
});

router.patch("/studio/characters/:id", async (req, res) => {
  const params = UpdateStudioCharacterParams.safeParse(req.params);
  const body = UpdateStudioCharacterBody.safeParse(req.body);
  if (!params.success || !body.success) {
    badRequest(
      res,
      !body.success
        ? body.error.issues[0]?.message ?? "Invalid character profile."
        : "Invalid character ID.",
    );
    return;
  }
  try {
    const [updated] = await db
      .update(studioCharactersTable)
      .set({ ...body.data, updatedAt: new Date() })
      .where(eq(studioCharactersTable.id, params.data.id))
      .returning();
    if (!updated) {
      notFound(res, "Character not found.");
      return;
    }
    res.json(characterDto(updated));
  } catch (error) {
    reportError(req, res, error);
  }
});

router.delete("/studio/characters/:id", async (req, res) => {
  const params = DeleteStudioCharacterParams.safeParse(req.params);
  if (!params.success) {
    badRequest(res, "Invalid character ID.");
    return;
  }
  try {
    const [deleted] = await db
      .delete(studioCharactersTable)
      .where(eq(studioCharactersTable.id, params.data.id))
      .returning({ id: studioCharactersTable.id });
    if (!deleted) {
      notFound(res, "Character not found.");
      return;
    }
    res.status(204).end();
  } catch (error) {
    reportError(req, res, error);
  }
});

router.post("/studio/projects/:id/jobs/story", async (req, res) => {
  const params = CreateStoryGenerationJobParams.safeParse(req.params);
  const body = CreateStoryGenerationJobBody.safeParse(req.body);
  if (!params.success || !body.success) {
    badRequest(
      res,
      !body.success
        ? body.error.issues[0]?.message ?? "Invalid story settings."
        : "Invalid project ID.",
    );
    return;
  }
  try {
    const project = await requireProject(params.data.id);
    if (!project) {
      notFound(res, "Project not found.");
      return;
    }
    const userId = getAuth(req).userId;
    if (!userId || !generationRateAllowed(userId)) {
      res.status(429).json({
        error: "Generation is limited to three submitted jobs per minute.",
      });
      return;
    }
    const quota = await canQueueProjectJob(project.id);
    if (!quota.allowed) {
      res.status(429).json({ error: quota.message });
      return;
    }
    const job = await queueStudioJob(project.id, "story", body.data);
    res.status(202).json(job);
  } catch (error) {
    reportError(req, res, error);
  }
});

router.post("/studio/projects/:id/jobs/scenes", async (req, res) => {
  const params = CreateSceneBreakdownJobParams.safeParse(req.params);
  if (!params.success) {
    badRequest(res, "Invalid project ID.");
    return;
  }
  try {
    const project = await requireProject(params.data.id);
    if (!project) {
      notFound(res, "Project not found.");
      return;
    }
    const userId = getAuth(req).userId;
    if (!userId || !generationRateAllowed(userId)) {
      res.status(429).json({
        error: "Generation is limited to three submitted jobs per minute.",
      });
      return;
    }
    const quota = await canQueueProjectJob(project.id);
    if (!quota.allowed) {
      res.status(429).json({ error: quota.message });
      return;
    }
    const job = await queueStudioJob(project.id, "scene_breakdown", {});
    res.status(202).json(job);
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/studio/jobs", async (req, res) => {
  const query = ListStudioJobsQueryParams.safeParse(req.query);
  if (!query.success) {
    badRequest(res, "Invalid job query.");
    return;
  }
  try {
    const rows = query.data.projectId
      ? await db
          .select()
          .from(studioJobsTable)
          .where(eq(studioJobsTable.projectId, query.data.projectId))
          .orderBy(desc(studioJobsTable.createdAt))
          .limit(100)
      : await db
          .select()
          .from(studioJobsTable)
          .orderBy(desc(studioJobsTable.createdAt))
          .limit(100);
    res.json(rows.map(jobDto));
  } catch (error) {
    reportError(req, res, error);
  }
});

router.post("/studio/jobs/:id/retry", async (req, res) => {
  const params = RetryStudioJobParams.safeParse(req.params);
  if (!params.success) {
    badRequest(res, "Invalid job ID.");
    return;
  }
  try {
    const job = await retryFailedStudioJob(params.data.id);
    if (!job) {
      res.status(409).json({ error: "Only failed jobs can be retried." });
      return;
    }
    res.status(202).json(job);
  } catch (error) {
    reportError(req, res, error);
  }
});

router.post("/studio/jobs/:id/cancel", async (req, res) => {
  const params = CancelStudioJobParams.safeParse(req.params);
  if (!params.success) {
    badRequest(res, "Invalid job ID.");
    return;
  }
  try {
    const [job] = await db
      .select()
      .from(studioJobsTable)
      .where(eq(studioJobsTable.id, params.data.id))
      .limit(1);
    if (!job) {
      notFound(res, "Job not found.");
      return;
    }
    if (job.status === "running") {
      await cancelRunningStudioJob(job.id);
      const [updated] = await db
        .update(studioJobsTable)
        .set({
          status: "cancelled",
          progress: 0,
          message: "Cancellation requested. No result will be saved.",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(studioJobsTable.id, job.id),
            eq(studioJobsTable.status, "running"),
          ),
        )
        .returning();
      if (!updated) {
        res.status(409).json({ error: "The job already finished." });
        return;
      }
      res.json(jobDto(updated));
      return;
    }
    if (job.status !== "queued") {
      res.status(409).json({ error: "This job is no longer cancellable." });
      return;
    }
    const [updated] = await db
      .update(studioJobsTable)
      .set({
        status: "cancelled",
        progress: 0,
        message: "Cancelled before processing.",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(studioJobsTable.id, job.id),
          eq(studioJobsTable.status, "queued"),
        ),
      )
      .returning();
    if (!updated) {
      res.status(409).json({ error: "The job was claimed before it could be cancelled." });
      return;
    }
    res.json(jobDto(updated));
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/studio/engines", async (req, res) => {
  try {
    res.json(await getStudioEngineHealth());
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/studio/backup", async (req, res) => {
  try {
    const [projects, scenes, characters] = await Promise.all([
      db.select().from(studioProjectsTable).orderBy(asc(studioProjectsTable.createdAt)),
      db.select().from(studioScenesTable).orderBy(asc(studioScenesTable.sequence)),
      db.select().from(studioCharactersTable).orderBy(asc(studioCharactersTable.name)),
    ]);
    res.json({
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      projects: projects.map(projectDto),
      scenes: scenes.map(sceneDto),
      characters: characters.map(characterDto),
    });
  } catch (error) {
    reportError(req, res, error);
  }
});

router.post("/studio/backup/restore", async (req, res) => {
  const parsed = RestoreStudioBackupBody.safeParse(req.body);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? "Invalid backup file.");
    return;
  }
  const backup = parsed.data;
  if (
    backup.projects.length > 500 ||
    backup.scenes.length > 50_000 ||
    backup.characters.length > 1_000
  ) {
    badRequest(res, "Backup exceeds the safety limits for this restore.");
    return;
  }
  const projectIds = new Set(backup.projects.map((project) => project.id));
  if (backup.scenes.some((scene) => !projectIds.has(scene.projectId))) {
    badRequest(res, "Backup contains a scene whose project is missing.");
    return;
  }
  try {
    const totals = await db.transaction(async (tx) => {
      await tx.delete(studioProjectsTable);
      await tx.delete(studioCharactersTable);
      if (backup.projects.length) {
        await tx.insert(studioProjectsTable).values(
          backup.projects.map((project) => ({
            ...project,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          })),
        );
      }
      if (backup.scenes.length) {
        await tx.insert(studioScenesTable).values(
          backup.scenes.map((scene) => ({
            ...scene,
            createdAt: scene.createdAt,
            updatedAt: scene.updatedAt,
          })),
        );
      }
      if (backup.characters.length) {
        await tx.insert(studioCharactersTable).values(
          backup.characters.map((character) => ({
            ...character,
            createdAt: character.createdAt,
            updatedAt: character.updatedAt,
          })),
        );
      }
      return {
        projects: backup.projects.length,
        scenes: backup.scenes.length,
        characters: backup.characters.length,
      };
    });
    res.json(totals);
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/studio/youtube/status", async (req, res) => {
  try {
    res.json(await youtubeStatus());
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/studio/youtube/connect", beginYouTubeOAuth);
router.get("/studio/youtube/callback", finishYouTubeOAuth);
router.delete("/studio/youtube/connection", async (req, res) => {
  try {
    await disconnectYouTube();
    res.status(204).end();
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/studio/youtube/analytics", async (req, res) => {
  try {
    res.json(await youtubeAnalytics());
  } catch (error) {
    reportError(req, res, error);
  }
});


router.post("/studio/projects/:id/youtube-upload", async (req, res) => {
  const params = GetStudioProjectParams.safeParse(req.params);
  const body = z.object({
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().max(5_000).default(""),
    privacyStatus: z.enum(["private", "unlisted", "public"]).default("private"),
  }).safeParse(req.body);
  if (!params.success || !body.success) {
    badRequest(res, !body.success ? body.error.issues[0]?.message ?? "Invalid upload details." : "Invalid project ID.");
    return;
  }
  try {
    const project = await requireProject(params.data.id);
    if (!project) { notFound(res, "Project not found."); return; }
    if (project.status !== "complete") {
      res.status(409).json({ error: "Render the project to a completed MP4 before uploading it." });
      return;
    }
    const status = await youtubeStatus();
    if (!status.configured || !status.connected) {
      res.status(409).json({ error: "Connect a YouTube channel before uploading a video." });
      return;
    }
    try { await access(studioVideoPath(project.id), constants.R_OK); }
    catch { res.status(404).json({ error: "Completed MP4 is missing. Render the project again before uploading." }); return; }
    const userId = getAuth(req).userId;
    if (!userId || !generationRateAllowed(userId)) {
      res.status(429).json({ error: "Upload submissions are limited to three jobs per minute." });
      return;
    }
    const duplicate = await db.select({ total: count() }).from(studioJobsTable).where(and(
      eq(studioJobsTable.projectId, project.id),
      eq(studioJobsTable.type, "youtube_upload"),
      inArray(studioJobsTable.status, ["queued", "running"]),
    ));
    if ((duplicate[0]?.total ?? 0) > 0) {
      res.status(409).json({ error: "A YouTube upload for this project is already queued or running." });
      return;
    }
    const job = await queueStudioJob(project.id, "youtube_upload", body.data);
    res.status(202).json(job);
  } catch (error) { reportError(req, res, error); }
});

router.get("/studio/projects/:id/video", async (req, res) => {
  const params = GetStudioProjectParams.safeParse(req.params);
  if (!params.success) { badRequest(res, "Invalid project ID."); return; }
  try {
    const project = await requireProject(params.data.id);
    if (!project) { notFound(res, "Project not found."); return; }
    if (project.status !== "video_ready") {
      res.status(409).json({ error: "No completed MP4 is available for this project yet." });
      return;
    }
    const outputPath = studioVideoPath(project.id);
    await access(outputPath, constants.R_OK);
    res.download(outputPath, "bhai-ai-" + project.id + ".mp4", (error) => {
      if (error) {
        req.log.error({ err: error, projectId: project.id }, "MP4 download failed");
        if (!res.headersSent) res.status(500).end();
      }
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      res.status(404).json({ error: "MP4 file not present. Configure a persistent STUDIO_MEDIA_DIR and render again." });
      return;
    }
    reportError(req, res, error);
  }
});

export default router;

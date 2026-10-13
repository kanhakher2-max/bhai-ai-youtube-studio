import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { studioVideoPath } from "./studioRenderer";

test("video path is placed inside the configured media directory", () => {
  const previous = process.env.STUDIO_MEDIA_DIR;
  process.env.STUDIO_MEDIA_DIR = "/tmp/bhai-studio-test-media";
  try {
    assert.equal(
      studioVideoPath("12345678-1234-4234-8234-123456789abc"),
      path.join("/tmp/bhai-studio-test-media", "12345678-1234-4234-8234-123456789abc.mp4"),
    );
  } finally {
    if (previous === undefined) delete process.env.STUDIO_MEDIA_DIR;
    else process.env.STUDIO_MEDIA_DIR = previous;
  }
});

test("video path rejects arbitrary filesystem paths", () => {
  assert.throws(() => studioVideoPath("../../etc/passwd"), /Invalid project ID/u);
});


import { execFileSync } from "node:child_process";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

test("renderer produces a probeable MP4 from a one-scene storyboard", async (t) => {
  try {
    execFileSync(process.env.STUDIO_FFMPEG_BIN || "ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
  } catch {
    t.skip("FFmpeg and ffprobe are not installed in this environment.");
    return;
  }
  const fonts = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
  ];
  let font: string | null = null;
  for (const candidate of fonts) {
    try { await access(candidate); font = candidate; break; } catch { /* try another font */ }
  }
  if (!font) {
    t.skip("No compatible test font is installed.");
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "bhai-render-test-"));
  const saved = {
    media: process.env.STUDIO_MEDIA_DIR,
    font: process.env.STUDIO_FONT_FILE,
    comfy: process.env.STUDIO_COMFY_IMAGE_WORKFLOW,
    prompt: process.env.STUDIO_COMFY_PROMPT_NODE_ID,
    piperBin: process.env.STUDIO_PIPER_BIN,
    piperModel: process.env.STUDIO_PIPER_MODEL,
  };
  process.env.STUDIO_MEDIA_DIR = dir;
  process.env.STUDIO_FONT_FILE = font;
  delete process.env.STUDIO_COMFY_IMAGE_WORKFLOW;
  delete process.env.STUDIO_COMFY_PROMPT_NODE_ID;
  delete process.env.STUDIO_PIPER_BIN;
  delete process.env.STUDIO_PIPER_MODEL;
  const projectId = randomUUID();
  try {
    const result = await renderStudioVideo({
      projectId,
      aspectRatio: "16:9",
      signal: new AbortController().signal,
      scenes: [{
        sequence: 1,
        title: "Opening scene",
        durationSeconds: 1,
        action: "A bridge at dawn",
        dialogue: "",
        narration: "A bridge at dawn",
        visualPrompt: "A bridge at dawn",
      }],
    });
    assert.equal(result.mode, "storyboard-cards");
    assert.equal(result.hasNarration, false);
    assert.ok(result.warnings.some((warning) => warning.includes("ComfyUI")));
    const filePath = result.outputPath;
    assert.equal(filePath, studioVideoPath(projectId));
    assert.ok((await stat(filePath)).size > 1_024);
    const duration = Number(execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", filePath,
    ], { encoding: "utf8" }).trim());
    assert.ok(duration >= 0.8 && duration <= 2.0, "rendered MP4 duration should be approximately one second");
  } finally {
    if (saved.media === undefined) delete process.env.STUDIO_MEDIA_DIR; else process.env.STUDIO_MEDIA_DIR = saved.media;
    if (saved.font === undefined) delete process.env.STUDIO_FONT_FILE; else process.env.STUDIO_FONT_FILE = saved.font;
    if (saved.comfy === undefined) delete process.env.STUDIO_COMFY_IMAGE_WORKFLOW; else process.env.STUDIO_COMFY_IMAGE_WORKFLOW = saved.comfy;
    if (saved.prompt === undefined) delete process.env.STUDIO_COMFY_PROMPT_NODE_ID; else process.env.STUDIO_COMFY_PROMPT_NODE_ID = saved.prompt;
    if (saved.piperBin === undefined) delete process.env.STUDIO_PIPER_BIN; else process.env.STUDIO_PIPER_BIN = saved.piperBin;
    if (saved.piperModel === undefined) delete process.env.STUDIO_PIPER_MODEL; else process.env.STUDIO_PIPER_MODEL = saved.piperModel;
    await rm(dir, { recursive: true, force: true });
  }
});

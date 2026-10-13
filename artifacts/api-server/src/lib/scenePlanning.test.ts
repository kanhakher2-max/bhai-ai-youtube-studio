import assert from "node:assert/strict";
import test from "node:test";
import {
  fitSceneDurations,
  getRetryPlan,
  planScriptScenes,
} from "./scenePlanning";

const fiveMinuteScript = Array.from(
  { length: 300 },
  (_, index) =>
    `word${index + 1}${index % 12 === 11 ? "." : ""}`,
).join(" ");

test("scene planner preserves the complete input and lands exactly on a 1-minute runtime", () => {
  const script = Array.from({ length: 120 }, (_, index) => `पंक्ति${index + 1}`).join(" ");
  const scenes = planScriptScenes({
    script,
    targetMinutes: 1,
    visualStyle: "anime",
  });
  assert.equal(scenes.length, 3);
  assert.equal(scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), 60);
  assert.equal(scenes.map((scene) => scene.action).join(" "), script);
  assert.ok(scenes.every((scene) => scene.durationSeconds >= 1));
});

test("a five-minute scene plan distributes time evenly and preserves continuity notes", () => {
  const scenes = planScriptScenes({
    script: fiveMinuteScript,
    targetMinutes: 5,
    visualStyle: "cinematic",
    characterContinuity: ["Mira: short hair, blue jacket"],
  });
  assert.equal(scenes.length, 15);
  assert.equal(scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), 300);
  assert.ok(
    scenes.every((scene) =>
      scene.visualPrompt.includes("Mira: short hair, blue jacket"),
    ),
  );
});

test("scene planner rejects empty or undersized scripts instead of creating empty scenes", () => {
  assert.throws(
    () =>
      planScriptScenes({
        script: " ",
        targetMinutes: 3,
        visualStyle: "realistic",
      }),
    /non-empty script/u,
  );
  assert.throws(
    () =>
      planScriptScenes({
        script: "two words",
        targetMinutes: 1,
        visualStyle: "realistic",
      }),
    /too short/u,
  );
});

test("transient errors retry only within the configured attempt limit", () => {
  assert.deepEqual(getRetryPlan(false, 1, 3), {
    retry: true,
    delayMs: 2_000,
  });
  assert.deepEqual(getRetryPlan(false, 3, 3), { retry: false, delayMs: 0 });
  assert.deepEqual(getRetryPlan(true, 1, 3), { retry: false, delayMs: 0 });
});

test("model-proposed scene durations are adjusted to the exact selected timeline", () => {
  const scenes = fitSceneDurations(
    [
      { durationSeconds: 11, title: "Opening" },
      { durationSeconds: 48, title: "Middle" },
      { durationSeconds: 9, title: "End" },
    ],
    300,
  );
  assert.equal(scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), 300);
  assert.ok(scenes.every((scene) => scene.durationSeconds >= 1));
  assert.deepEqual(scenes.map((scene) => scene.title), ["Opening", "Middle", "End"]);
});

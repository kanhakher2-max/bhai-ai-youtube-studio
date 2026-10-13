export type SceneDraft = {
  title: string;
  durationSeconds: number;
  action: string;
  dialogue: string;
  narration: string;
  background: string;
  camera: string;
  visualPrompt: string;
  audioNotes: string;
  transition: string;
};

const cameraDirections = [
  "Wide establishing shot; hold long enough to establish the space.",
  "Medium shot; keep the main action readable.",
  "Close-up on the most important reaction or object.",
  "Slow lateral move; keep motion restrained and motivated.",
  "Over-the-shoulder coverage; preserve screen direction.",
  "Return to a wide shot to show the scene's change.",
] as const;

const transitions = ["cut", "dissolve", "match cut", "cut"] as const;

function isSentenceBoundary(word: string): boolean {
  return /[.!?।]["'”’)\]]*$/u.test(word);
}

function splitBalanced(words: string[], count: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  const average = words.length / count;
  for (let scene = 0; scene < count; scene += 1) {
    const scenesLeft = count - scene - 1;
    const desiredEnd = Math.round((scene + 1) * average);
    const minimumEnd = start + 1;
    const maximumEnd = words.length - scenesLeft;
    let end = Math.max(minimumEnd, Math.min(maximumEnd, desiredEnd));
    if (scenesLeft > 0) {
      const searchStart = Math.max(minimumEnd, end - 8);
      const searchEnd = Math.min(maximumEnd, end + 8);
      let closest: number | null = null;
      for (let candidate = searchStart; candidate <= searchEnd; candidate += 1) {
        if (isSentenceBoundary(words[candidate - 1] ?? "")) {
          if (closest === null || Math.abs(candidate - end) < Math.abs(closest - end)) {
            closest = candidate;
          }
        }
      }
      if (closest !== null) end = closest;
    }
    chunks.push(words.slice(start, end).join(" "));
    start = end;
  }
  return chunks;
}

function allocateDurations(weights: number[], totalSeconds: number): number[] {
  if (!weights.length || totalSeconds < weights.length) {
    throw new Error("The requested runtime is too short for the generated scene count.");
  }
  const remaining = totalSeconds - weights.length;
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(weightTotal) || weightTotal <= 0) {
    throw new Error("Scene durations could not be calculated from the script.");
  }
  const exact = weights.map((weight) => (remaining * weight) / weightTotal);
  const base = exact.map((value) => Math.floor(value) + 1);
  let secondsLeft = totalSeconds - base.reduce((sum, value) => sum + value, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((left, right) => right.remainder - left.remainder);
  for (let index = 0; secondsLeft > 0; index += 1, secondsLeft -= 1) {
    const target = byRemainder[index % byRemainder.length];
    if (target) base[target.index] += 1;
  }
  return base;
}

export function planScriptScenes(input: {
  script: string;
  targetMinutes: number;
  visualStyle: string;
  characterContinuity?: string[];
}): SceneDraft[] {
  const script = input.script.trim();
  const words = script.split(/\s+/u).filter(Boolean);
  const targetSeconds = input.targetMinutes * 60;
  if (!script || !Number.isInteger(targetSeconds) || targetSeconds < 60) {
    throw new Error("A non-empty script and a valid target duration are required.");
  }
  if (words.length < 3) {
    throw new Error("The script is too short to create a useful scene plan.");
  }
  const sceneCount = Math.max(3, Math.ceil(targetSeconds / 20));
  if (sceneCount > words.length) {
    throw new Error("The script needs more spoken words for this many scenes.");
  }
  const chunks = splitBalanced(words, sceneCount);
  const durations = allocateDurations(
    chunks.map((chunk) => chunk.split(/\s+/u).length),
    targetSeconds,
  );
  const characterNotes = (input.characterContinuity ?? [])
    .map((note) => note.trim())
    .filter(Boolean)
    .join(" ");
  return chunks.map((chunk, index) => {
    const number = String(index + 1).padStart(2, "0");
    const shortTitle = chunk
      .replace(/[^\p{L}\p{N}\s'-]/gu, "")
      .split(/\s+/u)
      .slice(0, 7)
      .join(" ");
    const speakerLabel =
      /(?:^|\s)[\p{L}\p{M}][\p{L}\p{M}\s'-]{0,35}:\s/u.test(chunk);
    return {
      title: `Scene ${number}: ${shortTitle}`.slice(0, 160),
      durationSeconds: durations[index] ?? 1,
      action: chunk,
      dialogue: speakerLabel ? chunk : "",
      narration: speakerLabel ? "" : chunk,
      background: "Use only locations and props implied by the script.",
      camera: cameraDirections[index % cameraDirections.length] ?? cameraDirections[0],
      visualPrompt: [
        `${input.visualStyle} visual direction.`,
        "Draft prompt derived from the creator's script; do not add new story facts.",
        characterNotes ? `Character continuity: ${characterNotes}` : "",
        `Scene content: ${chunk.slice(0, 1_200)}`,
      ]
        .filter(Boolean)
        .join(" "),
      audioNotes: "Planned spoken content is preserved; no audio has been generated.",
      transition: transitions[index % transitions.length] ?? "cut",
    };
  });
}

export function fitSceneDurations<T extends { durationSeconds: number }>(
  scenes: readonly T[],
  targetSeconds: number,
): T[] {
  const durations = allocateDurations(
    scenes.map((scene) => scene.durationSeconds),
    targetSeconds,
  );
  return scenes.map((scene, index) => ({
    ...scene,
    durationSeconds: durations[index] ?? 1,
  }));
}

export function getRetryPlan(
  permanent: boolean,
  attempt: number,
  maxAttempts: number,
): { retry: boolean; delayMs: number } {
  const retry = !permanent && attempt < maxAttempts;
  return {
    retry,
    delayMs: retry ? 2 ** Math.min(Math.max(0, attempt), 4) * 1_000 : 0,
  };
}

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

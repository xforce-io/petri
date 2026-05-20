import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTrack, listTracks, loadTrack, runRootForTrack } from "../../src/engine/track.js";

let tmpDir: string | undefined;

function makeTmpDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-track-test-"));
  return tmpDir;
}

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("track metadata", () => {
  it("creates and loads a named exploration track", () => {
    const dir = makeTmpDir();

    const track = createTrack(dir, "factor-weight-search", {
      objective: "Tune factor weights",
      baseline: "run_007_production",
    });

    expect(track.track_id).toBe("factor-weight-search");
    expect(fs.existsSync(path.join(dir, ".petri/tracks/factor-weight-search/track.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".petri/tracks/factor-weight-search/runs"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".petri/tracks/factor-weight-search/artifacts"))).toBe(true);

    const loaded = loadTrack(dir, "factor-weight-search");
    expect(loaded.objective).toBe("Tune factor weights");
    expect(loaded.baseline).toBe("run_007_production");
  });

  it("lists tracks in sorted order", () => {
    const dir = makeTmpDir();
    createTrack(dir, "z-track");
    createTrack(dir, "a-track");

    expect(listTracks(dir).map((track) => track.track_id)).toEqual(["a-track", "z-track"]);
  });

  it("resolves the run root for default and tracked runs", () => {
    const dir = makeTmpDir();

    expect(runRootForTrack(dir)).toBe(path.join(dir, ".petri"));
    expect(runRootForTrack(dir, "abc")).toBe(path.join(dir, ".petri", "tracks", "abc"));
  });

  it("rejects invalid track ids", () => {
    const dir = makeTmpDir();

    expect(() => createTrack(dir, "../bad")).toThrow(/Track id/);
  });
});

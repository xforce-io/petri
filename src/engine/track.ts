import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { TrackConfig } from "../types.js";

const TRACK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface CreateTrackOptions {
  objective?: string;
  baseline?: string;
}

export function normalizeTrackId(trackId: string): string {
  const id = trackId.trim();
  if (!TRACK_ID_RE.test(id)) {
    throw new Error("Track id must start with a letter or number and contain only letters, numbers, '.', '_' or '-'.");
  }
  return id;
}

export function tracksRoot(projectDir: string): string {
  return path.join(projectDir, ".petri", "tracks");
}

export function trackDir(projectDir: string, trackId: string): string {
  return path.join(tracksRoot(projectDir), normalizeTrackId(trackId));
}

export function trackConfigPath(projectDir: string, trackId: string): string {
  return path.join(trackDir(projectDir, trackId), "track.yaml");
}

export function createTrack(projectDir: string, trackId: string, opts: CreateTrackOptions = {}): TrackConfig {
  const id = normalizeTrackId(trackId);
  const dir = trackDir(projectDir, id);
  const configPath = path.join(dir, "track.yaml");
  if (fs.existsSync(configPath)) {
    throw new Error(`Track already exists: ${id}`);
  }

  const config: TrackConfig = {
    schema_version: 1,
    track_id: id,
    status: "active",
    objective: opts.objective,
    baseline: opts.baseline,
    created_at: new Date().toISOString(),
  };

  fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  fs.writeFileSync(configPath, stringifyYaml(config), "utf-8");
  return config;
}

export function loadTrack(projectDir: string, trackId: string): TrackConfig {
  const id = normalizeTrackId(trackId);
  const configPath = trackConfigPath(projectDir, id);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Track not found: ${id}. Create it with 'petri track init ${id}'.`);
  }
  const raw = parseYaml(fs.readFileSync(configPath, "utf-8")) as TrackConfig;
  if (!raw || raw.track_id !== id) {
    throw new Error(`Invalid track.yaml for track ${id}`);
  }
  return raw;
}

export function listTracks(projectDir: string): TrackConfig[] {
  const root = tracksRoot(projectDir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .sort()
    .map((name) => {
      const configPath = path.join(root, name, "track.yaml");
      if (!fs.existsSync(configPath)) return null;
      try {
        return parseYaml(fs.readFileSync(configPath, "utf-8")) as TrackConfig;
      } catch {
        return null;
      }
    })
    .filter((track): track is TrackConfig => !!track && typeof track.track_id === "string");
}

export function runRootForTrack(projectDir: string, trackId?: string): string {
  return trackId ? trackDir(projectDir, trackId) : path.join(projectDir, ".petri");
}


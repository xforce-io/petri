import chalk from "chalk";
import { createTrack, listTracks } from "../engine/track.js";

export interface TrackInitOptions {
  objective?: string;
  baseline?: string;
}

export async function trackInitCommand(trackId: string, opts: TrackInitOptions): Promise<void> {
  const cwd = process.cwd();
  try {
    const track = createTrack(cwd, trackId, opts);
    console.log(chalk.green(`Created track: ${track.track_id}`));
    if (track.objective) console.log(chalk.gray(`Objective: ${track.objective}`));
    if (track.baseline) console.log(chalk.gray(`Baseline: ${track.baseline}`));
    console.log(chalk.gray(`Path: .petri/tracks/${track.track_id}`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Error: ${msg}`));
    process.exit(1);
  }
}

export async function trackListCommand(): Promise<void> {
  const tracks = listTracks(process.cwd());
  if (tracks.length === 0) {
    console.log(chalk.gray("No tracks found. Use `petri track init <id>` to create one."));
    return;
  }

  console.log(chalk.bold("Tracks:"));
  for (const track of tracks) {
    const status = track.status ?? "active";
    const objective = track.objective ? ` — ${track.objective}` : "";
    console.log(`  ${chalk.cyan(track.track_id)}  ${chalk.gray(status)}${objective}`);
  }
}

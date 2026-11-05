import type { ConsoleLine } from '../types.js';

export interface StartupProgress {
  /** Human-readable current startup stage, never inferred from elapsed time. */
  stage: string;
  /** Minecraft-reported percentage of the current spawn-area stage, not total startup. */
  percent: number | null;
  /** A complete Minecraft Done line was observed; callers must still probe network readiness. */
  isReady: boolean;
}

const LAUNCH_MARKER = /^Starting (?:Java\s|Bedrock Dedicated Server\s*\()/;

function logBody(message: string): string {
  // Vanilla, Paper, and Forge use different combinations of timestamp, thread,
  // level, and logger prefixes. An arbitrary [Player] or [Plugin] prefix is
  // deliberately retained so its message cannot become a startup announcement.
  let remaining = message.replace(/\x1b\[[0-9;]*m/g, '').trim();
  const standard = /^(?:\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?(?:\s+(?:INFO|WARN|ERROR|DEBUG|TRACE|FATAL))?|[^\]\r\n]{1,100}\/(?:INFO|WARN|ERROR|DEBUG|TRACE|FATAL)|INFO|WARN|ERROR|DEBUG|TRACE|FATAL)$/i;
  const minecraftLogger = /^(?:minecraft|net\.minecraft(?:\.[a-z0-9_.]+)?|com\.mojang(?:\.[a-z0-9_.]+)?)\/[a-z0-9_.$]+$/i;
  for (;;) {
    const prefix = /^\[([^\]\r\n]{1,160})\]\s*/.exec(remaining);
    if (!prefix || !standard.test(prefix[1]) && !minecraftLogger.test(prefix[1])) break;
    remaining = remaining.slice(prefix[0].length);
  }
  return remaining.replace(/^:\s*/, '').trim();
}

/** Tracks one launch. Percentages are real stage progress, not a synthetic clock. */
export class StartupProgressTracker {
  private progress: StartupProgress = { stage: 'Starting server', percent: null, isReady: false };
  private dimension: string | null = null;

  reset(): void {
    this.progress = { stage: 'Starting server', percent: null, isReady: false };
    this.dimension = null;
  }

  snapshot(): StartupProgress {
    return { ...this.progress };
  }

  observe(line: ConsoleLine): void {
    if (line.stream === 'system') {
      if (LAUNCH_MARKER.test(line.message)) this.reset();
      return;
    }
    const body = logBody(line.message);
    if (this.progress.isReady) return;

    if (/^Done \(\d+(?:\.\d+)?s\)! For help, type ["']help["']\s*$/i.test(body)) {
      this.progress = { stage: 'Finishing startup', percent: null, isReady: true };
      return;
    }
    const dimension = /^Preparing start region for (?:dimension\s+([a-z0-9_.-]+:[a-z0-9_/.-]+)|level\s+(-?\d{1,3}))\s*$/i.exec(body);
    if (dimension) {
      this.dimension = dimension[1] ?? `level ${dimension[2]}`;
      this.progress = { stage: `Preparing spawn area (${this.dimension})`, percent: null, isReady: false };
      return;
    }
    const spawn = /^Preparing spawn area:\s*(\d+(?:\.\d+)?)\s*%\s*$/i.exec(body);
    if (spawn) {
      const percent = Number(spawn[1]);
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) return;
      const stage = this.dimension ? `Preparing spawn area (${this.dimension})` : 'Preparing spawn area';
      this.progress = { stage, percent: Math.max(this.progress.stage === stage ? this.progress.percent ?? 0 : 0, percent), isReady: false };
      return;
    }
    let stage: string | undefined;
    if (/^(?:Loading libraries, please wait|Starting org\.bukkit\.craftbukkit\.Main|ModLauncher running:|Loading Minecraft\s)/i.test(body)) stage = 'Loading server libraries';
    else if (/^Starting minecraft server version\s+\S+/i.test(body)) stage = 'Starting Minecraft';
    else if (/^(?:Loaded \d+ (?:recipes|advancements)|Reloading ResourceManager:)/i.test(body)) stage = 'Loading game data';
    else if (/^Preparing level\s+["']/i.test(body)) stage = 'Loading worlds';
    else if (/^Time elapsed:\s*\d+\s*ms\s*$/i.test(body) && this.progress.stage.startsWith('Preparing spawn area')) stage = 'Finishing world preparation';
    if (stage) this.progress = { stage, percent: null, isReady: false };
  }
}

/** Reconstruct only this launch when the runtime retains earlier console lines. */
export function startupProgressFromLogs(lines: readonly ConsoleLine[], startedAt?: string | null): StartupProgress {
  const tracker = new StartupProgressTracker();
  const since = startedAt ? Date.parse(startedAt) : Number.NaN;
  let first = 0;
  if (!Number.isFinite(since)) {
    first = -1;
    for (let index = lines.length - 1; index >= 0; index--) {
      if (lines[index].stream === 'system' && LAUNCH_MARKER.test(lines[index].message)) { first = index; break; }
    }
    // A truncated log tail without a launch identity must not resurrect Done
    // from an older process. A known current launch timestamp avoids this case.
    if (first === -1) return tracker.snapshot();
  }
  for (const line of lines.slice(first)) {
    if (Number.isFinite(since)) {
      const timestamp = Date.parse(line.timestamp);
      if (!Number.isFinite(timestamp) || timestamp < since) continue;
    }
    tracker.observe(line);
  }
  return tracker.snapshot();
}

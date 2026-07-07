/**
 * Injected host services (AD-9). Core never touches electron, raw sockets, or
 * the process table directly — the desktop main process (or a test harness)
 * supplies implementations.
 */

export interface Clock {
  /** Wall-clock ms since Unix epoch. */
  wall(): number;
  /** Monotonic ms — the shared host-session timeline. */
  mono(): number;
}

export const systemClock: Clock = {
  wall: () => Date.now(),
  mono: () => performance.now(),
};

export interface DiscoveredServer {
  port: number;
  pid?: number;
  cmd?: string;
  cwd?: string;
  /** package.json name (else project folder name) inferred from cwd. */
  projectName?: string;
  protocol: 'http' | 'https';
  /** Process %CPU (from ps). */
  cpuPercent?: number;
  /** Process resident set size, bytes (from ps rss). */
  memBytes?: number;
  /** Process start time, epoch ms (from ps lstart). */
  startedAtWall?: number;
  /** Type badge, inferred from package.json deps. */
  serverType?: 'frontend' | 'backend' | 'fullstack';
  /** Stable framework id for the card icon. */
  frameworkId?: string;
  /** Human framework label. */
  frameworkHint?: string;
}

/** Port/process discovery (infra #11). Real impl (lsof/ps) lands with the shell. */
export interface ProcessInspector {
  listListeningServers(): Promise<DiscoveredServer[]>;
  envOf(pid: number): Promise<Record<string, string> | undefined>;
}

export interface FileSystemLike {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdirp(path: string): Promise<void>;
}

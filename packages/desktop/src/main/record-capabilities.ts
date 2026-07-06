import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CapabilityFault, type Core, type EventStore } from '@localcoast/core';
import { localcoastHome } from '@localcoast/mcp';
import {
  ActRecordStartInput,
  ActRecordStartOutput,
  ActRecordStopInput,
  ActRecordStopOutput,
} from '@localcoast/protocol-types';
import type { z } from 'zod';
import type { GuestTab, TabManager } from './tabs.js';

/**
 * Screen recording (spec: lc_act_record): CDP Page.startScreencast frames
 * written as a JPEG sequence + timestamped manifest.json. The consumer is a
 * coding agent inspecting animations frame by frame, so no video encoding —
 * frames are individually readable images and the manifest reconstructs
 * timing. Frames are pixels and cannot pass text redaction (invariant 8);
 * exposure class is identical to act.screenshot.
 */

type StartInput = z.infer<typeof ActRecordStartInput>;
type StartOutput = z.infer<typeof ActRecordStartOutput>;
type StopInput = z.infer<typeof ActRecordStopInput>;
type StopOutput = z.infer<typeof ActRecordStopOutput>;
type StoppedBy = StopOutput['stoppedBy'];

/** Fallback keyframe cadence when the screencast is quiet (static content). */
const POLL_INTERVAL_MS = 500;

interface Recording {
  recordingId: string;
  sessionId: string;
  dir: string;
  /** Kept directly — the tab may already be closed when we finalize. */
  cdp: GuestTab['cdp'];
  webContents: GuestTab['view']['webContents'];
  params: StartInput;
  startedWall: number;
  startedMono: number;
  viewport: { width: number; height: number };
  frames: Array<{ file: string; tMs: number; source: 'screencast' | 'screenshot'; cdpTimestamp?: number }>;
  sizeBytes: number;
  /** Sequential, never-rejecting disk pipeline; frame order preserved. */
  writeChain: Promise<void>;
  writeErrors: string[];
  unsubscribe: () => void;
  timer: NodeJS.Timeout;
  /** Screenshot-fallback keyframes: screencast emits nothing for static
   *  content or initial paints, so poll a screenshot whenever it goes quiet. */
  poller: NodeJS.Timeout;
  lastFrameMono: number;
  pollInFlight: boolean;
  /** Set once by whichever trigger (stop/timer/maxFrames/tab-close) wins. */
  finalizePromise?: Promise<StopOutput>;
}

export class TabRecorder {
  private byId = new Map<string, Recording>();
  private bySession = new Map<string, string>();

  constructor(private readonly store: EventStore) {}

  async start(tab: GuestTab, input: StartInput): Promise<StartOutput> {
    const existingId = this.bySession.get(tab.sessionId);
    const existing = existingId ? this.byId.get(existingId) : undefined;
    if (existing && !existing.finalizePromise) {
      throw new CapabilityFault(
        'invalid_input',
        `session already recording (${existing.recordingId}) — call act.record.stop first`,
      );
    }
    // A finished leftover awaiting a stop call is evicted; its files persist.
    if (existingId) this.byId.delete(existingId);

    const recordingId = `rec-${randomBytes(6).toString('hex')}`;
    const dir = join(localcoastHome(), 'recordings', recordingId);
    await mkdir(dir, { recursive: true });

    const bounds = tab.view.getBounds();
    const rec: Recording = {
      recordingId,
      sessionId: tab.sessionId,
      dir,
      cdp: tab.cdp,
      webContents: tab.view.webContents,
      params: input,
      startedWall: Date.now(),
      startedMono: performance.now(),
      viewport: { width: bounds.width, height: bounds.height },
      frames: [],
      sizeBytes: 0,
      writeChain: Promise.resolve(),
      writeErrors: [],
      unsubscribe: () => undefined,
      timer: setTimeout(() => void this.finalize(rec, 'maxDuration'), input.maxDurationMs),
      poller: setInterval(() => void this.pollScreenshot(rec), POLL_INTERVAL_MS),
      lastFrameMono: 0,
      pollInFlight: false,
    };

    rec.unsubscribe = tab.cdp.onEvent(({ cdpSessionId, method, params }) => {
      if (method !== 'Page.screencastFrame') return;
      const frame = params as { data: string; metadata?: { timestamp?: number }; sessionId: number };
      // CDP's frame token is (confusingly) named sessionId — an integer,
      // unrelated to the LocalCoast session. Ack FIRST, unconditionally,
      // before any status check: an un-acked frame stalls the stream.
      const frameAckId = frame.sessionId;
      void tab.cdp
        .send(cdpSessionId, 'Page.screencastFrameAck', { sessionId: frameAckId })
        .catch(() => undefined);
      this.addFrame(rec, Buffer.from(frame.data, 'base64'), 'screencast', frame.metadata?.timestamp);
    });

    try {
      await tab.cdp.send(null, 'Page.startScreencast', {
        format: 'jpeg',
        quality: input.quality,
        maxWidth: input.maxWidth,
        maxHeight: 1280,
        everyNthFrame: input.everyNthFrame,
      });
    } catch (err) {
      rec.unsubscribe();
      clearTimeout(rec.timer);
      throw new CapabilityFault('internal', `startScreencast failed: ${String(err)}`);
    }

    // Keep the compositor committing while backgrounded/occluded for the
    // recording's duration (restored at finalize).
    tab.view.webContents.setBackgroundThrottling(false);

    this.byId.set(recordingId, rec);
    this.bySession.set(tab.sessionId, recordingId);
    return { recordingId, dir };
  }

  async stop(input: StopInput): Promise<StopOutput> {
    const id = input.recordingId ?? (input.sessionId ? this.bySession.get(input.sessionId) : undefined);
    if (!id) throw new CapabilityFault('invalid_input', 'provide recordingId or sessionId');
    const rec = this.byId.get(id);
    if (!rec) throw new CapabilityFault('not_found', `no recording ${id}`);
    // If a timer/maxFrames/tab-close already finalized, this returns the
    // cached result — stop is how the caller collects it either way.
    const result = await this.finalize(rec, 'stop');
    this.byId.delete(id);
    if (this.bySession.get(rec.sessionId) === id) this.bySession.delete(rec.sessionId);
    return result;
  }

  /** Tab close hook (main.ts): finalize whatever is in flight; never throws. */
  async finalizeForSession(sessionId: string, reason: 'tab_closed'): Promise<void> {
    const id = this.bySession.get(sessionId);
    const rec = id ? this.byId.get(id) : undefined;
    if (!rec) return;
    await this.finalize(rec, reason).catch(() => undefined);
  }

  /** Shared sink for screencast frames and screenshot keyframes. */
  private addFrame(
    rec: Recording,
    buf: Buffer,
    source: 'screencast' | 'screenshot',
    cdpTimestamp?: number,
  ): void {
    if (rec.finalizePromise) return;
    if (rec.frames.length >= rec.params.maxFrames) {
      void this.finalize(rec, 'maxFrames');
      return;
    }
    rec.lastFrameMono = performance.now();
    const file = `frame-${String(rec.frames.length).padStart(5, '0')}.jpg`;
    rec.frames.push({
      file,
      tMs: Math.round(rec.lastFrameMono - rec.startedMono),
      source,
      cdpTimestamp,
    });
    rec.sizeBytes += buf.byteLength;
    rec.writeChain = rec.writeChain
      .then(() => writeFile(join(rec.dir, file), buf))
      .catch((err: unknown) => {
        rec.writeErrors.push(`${file}: ${String(err)}`);
      });
  }

  /**
   * Screencast emits only on renderer ANIMATION commits — static pages and
   * fresh-navigation paints yield nothing (verified empirically on Electron).
   * captureScreenshot always works, so it backfills keyframes whenever the
   * screencast has been quiet for a poll interval.
   */
  private async pollScreenshot(rec: Recording): Promise<void> {
    if (rec.finalizePromise || rec.pollInFlight) return;
    if (performance.now() - rec.lastFrameMono < POLL_INTERVAL_MS * 0.9) return;
    rec.pollInFlight = true;
    try {
      const shot = (await rec.cdp.send(null, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality: rec.params.quality,
      })) as { data: string };
      this.addFrame(rec, Buffer.from(shot.data, 'base64'), 'screenshot');
    } catch {
      /* renderer busy/gone — next tick retries */
    } finally {
      rec.pollInFlight = false;
    }
  }

  private finalize(rec: Recording, stoppedBy: StoppedBy): Promise<StopOutput> {
    rec.finalizePromise ??= this.doFinalize(rec, stoppedBy);
    return rec.finalizePromise;
  }

  private async doFinalize(rec: Recording, stoppedBy: StoppedBy): Promise<StopOutput> {
    clearTimeout(rec.timer);
    clearInterval(rec.poller);
    rec.unsubscribe();
    try {
      if (!rec.webContents.isDestroyed()) rec.webContents.setBackgroundThrottling(true);
    } catch {
      /* tab already gone */
    }
    // Best-effort: the tab (or its renderer) may already be gone.
    await rec.cdp.send(null, 'Page.stopScreencast', {}).catch(() => undefined);
    await rec.writeChain;

    const durationMs = Math.round(performance.now() - rec.startedMono);
    const manifest = {
      version: 1,
      recordingId: rec.recordingId,
      sessionId: rec.sessionId,
      startedAtWall: rec.startedWall,
      durationMs,
      stoppedBy,
      viewport: rec.viewport,
      params: rec.params,
      writeErrors: rec.writeErrors,
      frames: rec.frames.map((f, i) => ({
        ...f,
        deltaMs: f.tMs - (rec.frames[i - 1]?.tMs ?? f.tMs),
      })),
    };
    const manifestPath = join(rec.dir, 'manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    if (stoppedBy !== 'stop') {
      this.store.appendNow({
        sessionId: rec.sessionId,
        actor: 'system',
        type: 'console.entry',
        payload: {
          level: 'info',
          source: 'localcoast',
          text: `recording ${rec.recordingId} auto-stopped (${stoppedBy}): ${rec.frames.length} frames → ${rec.dir}`,
        },
      });
    }

    return {
      recordingId: rec.recordingId,
      dir: rec.dir,
      manifestPath,
      frameCount: rec.frames.length,
      sizeBytes: rec.sizeBytes,
      durationMs,
      stoppedBy,
      frames: rec.frames.map(({ file, tMs }) => ({ file, tMs })),
    };
  }
}

export function registerRecordCapabilities(core: Core, tabs: TabManager, recorder: TabRecorder): void {
  core.registry.registerCommand({
    name: 'act.record.start',
    description:
      'Start a screen recording of a guest tab via CDP screencast. Frames are written as individual JPEG files (readable as images by agents) with a manifest.json of per-frame timestamps — inspect animations/transitions frame by frame; no video container. Auto-stops at maxDurationMs or maxFrames. Frames are raw pixels: like act.screenshot they bypass text redaction.',
    input: ActRecordStartInput,
    output: ActRecordStartOutput,
    surfaces: { palette: true },
    paletteTitle: 'Start recording',
    handler: async (input) => {
      const tab = tabs.get(input.sessionId);
      if (!tab) throw new CapabilityFault('target_gone', `no open tab ${input.sessionId}`);
      // Hidden tabs never repaint, so the screencast would yield no frames.
      tabs.activate(input.sessionId);
      return recorder.start(tab, input);
    },
  });

  core.registry.registerCommand({
    name: 'act.record.stop',
    description:
      'Stop a screen recording and return the frame manifest: directory, per-frame files with timestamps (tMs offsets from start), byte size, and what stopped it. Read individual frame files as images to inspect the animation. Also collects the result of a recording that already auto-stopped.',
    input: ActRecordStopInput,
    output: ActRecordStopOutput,
    surfaces: { palette: true },
    paletteTitle: 'Stop recording',
    handler: async (input) => recorder.stop(input),
  });
}

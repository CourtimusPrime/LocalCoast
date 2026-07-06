import { z } from 'zod';
import type { EventStore } from './events/store.js';
import {
  CapabilityFault,
  CapabilityRegistry,
  type DispatchContext,
  type Registered,
} from './registry.js';

/**
 * The one Core (AD-5). UI panels, the palette, and generated MCP tools all
 * dispatch through query/command/subscribe — no other data path exists. Every
 * command emits an `action.dispatched` audit event with its actor, which is
 * how agent actions become visible inside the product timeline.
 */

export class Core {
  readonly registry = new CapabilityRegistry();

  constructor(readonly store: EventStore) {}

  private lookup(name: string, kinds: Array<Registered['kind']>): Registered {
    const cap = this.registry.get(name);
    if (!cap || !kinds.includes(cap.kind)) {
      throw new CapabilityFault('not_found', `no ${kinds.join('/')} capability named ${name}`);
    }
    return cap;
  }

  private parseInput(cap: Registered, rawInput: unknown): unknown {
    const result = cap.input.safeParse(rawInput ?? {});
    if (!result.success) {
      throw new CapabilityFault('invalid_input', `invalid input for ${cap.name}`, result.error.issues);
    }
    return result.data;
  }

  private parseOutput(cap: Registered, rawOutput: unknown): unknown {
    const result = cap.output.safeParse(rawOutput);
    if (!result.success) {
      throw new CapabilityFault(
        'invalid_output',
        `capability ${cap.name} produced output violating its schema`,
        result.error.issues,
      );
    }
    return result.data;
  }

  async query(name: string, rawInput: unknown, ctx: DispatchContext): Promise<unknown> {
    const cap = this.lookup(name, ['query']);
    const input = this.parseInput(cap, rawInput);
    const output = await (cap.handler as (i: unknown, c: DispatchContext) => unknown)(input, ctx);
    return this.parseOutput(cap, output);
  }

  async command(name: string, rawInput: unknown, ctx: DispatchContext): Promise<unknown> {
    const cap = this.lookup(name, ['command']);
    const input = this.parseInput(cap, rawInput);
    const started = performance.now();
    const sessionId =
      typeof input === 'object' && input !== null && 'sessionId' in input
        ? String((input as { sessionId: unknown }).sessionId)
        : 'core';
    try {
      const output = await (cap.handler as (i: unknown, c: DispatchContext) => unknown)(input, ctx);
      const parsed = this.parseOutput(cap, output);
      this.audit(cap.name, sessionId, ctx, input, true, undefined, performance.now() - started);
      return parsed;
    } catch (err) {
      this.audit(cap.name, sessionId, ctx, input, false, String(err), performance.now() - started);
      throw err;
    }
  }

  subscribe(
    name: string,
    rawInput: unknown,
    ctx: DispatchContext,
    onData: (data: unknown) => void,
  ): () => void {
    const cap = this.lookup(name, ['subscription']);
    const input = this.parseInput(cap, rawInput);
    return (cap.handler as (i: unknown, c: DispatchContext, e: (d: unknown) => void) => () => void)(
      input,
      ctx,
      (data) => onData(this.parseOutput(cap, data)),
    );
  }

  private audit(
    capability: string,
    sessionId: string,
    ctx: DispatchContext,
    input: unknown,
    ok: boolean,
    error: string | undefined,
    durationMs: number,
  ): void {
    try {
      this.store.appendNow({
        sessionId,
        actor: ctx.actor,
        type: 'action.dispatched',
        payload: {
          capability,
          argsPreview: JSON.stringify(input).slice(0, 512),
          ok,
          error,
          durationMs,
        },
      });
    } catch {
      // The audit trail must never break the command itself (e.g. store closed
      // mid-shutdown); dispatch outcome already propagated to the caller.
    }
  }
}

/** Shared helper for capability modules that page reverse-chronologically. */
export function nextBeforeId(events: Array<{ id: number }>, limit: number): number | undefined {
  return events.length >= limit ? events[0]?.id : undefined;
}

export { z };

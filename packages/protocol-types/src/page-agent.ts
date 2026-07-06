import { z } from 'zod';
import { StorageAreaSchema, TrimmedStackSchema } from './events.js';

/**
 * Page-agent ↔ host wire contract (AD-4). The inspected page is UNTRUSTED:
 * the host validates every binding payload against these schemas before any
 * event reaches the store, and never evals page-supplied data. Messages batch
 * through a ring buffer flushed per-rAF; each flush is one BatchSchema value.
 */

export const AgentStorageOpSchema = z.object({
  kind: z.literal('storage.op'),
  area: StorageAreaSchema,
  op: z.enum(['read', 'write', 'remove', 'clear']),
  key: z.string().max(1024).optional(),
  valueSize: z.number().int().nonnegative().optional(),
  valuePreview: z.string().max(256).optional(),
  stack: TrimmedStackSchema.optional(),
  /** Page-relative ms (performance.now() in the guest); host rebases. */
  t: z.number(),
});

export const AgentRouteSchema = z.object({
  kind: z.literal('state.route'),
  from: z.string().max(4096).optional(),
  to: z.string().max(4096),
  routeKind: z.enum(['push', 'replace', 'pop', 'hashchange']),
  t: z.number(),
});

export const AgentWsSchema = z.object({
  kind: z.literal('ws'),
  socketId: z.number().int(),
  phase: z.enum(['created', 'sent', 'closed']),
  url: z.string().max(4096).optional(),
  payloadSize: z.number().int().nonnegative().optional(),
  payloadPreview: z.string().max(256).optional(),
  t: z.number(),
});

export const AgentFrameworkDetectedSchema = z.object({
  kind: z.literal('framework.detected'),
  framework: z.enum(['react', 'vue', 'svelte']),
  version: z.string().max(64).optional(),
  devBuild: z.boolean().optional(),
  t: z.number(),
});

export const AgentErrorSchema = z.object({
  kind: z.literal('agent.error'),
  message: z.string().max(2048),
  t: z.number(),
});

/** L3 store action observed through the Redux-DevTools shim. */
export const AgentStateActionSchema = z.object({
  kind: z.literal('state.action'),
  storeId: z.string().max(256),
  actionType: z.string().max(256),
  payloadPreview: z.string().max(256).optional(),
  t: z.number(),
});

/** rAF-coalesced framework commit burst — count, never a serialized tree. */
export const AgentStateCommitSchema = z.object({
  kind: z.literal('state.commit'),
  framework: z.enum(['react', 'vue', 'svelte']),
  count: z.number().int().positive().max(10_000),
  t: z.number(),
});

export const AgentPerfLongTaskSchema = z.object({
  kind: z.literal('perf.longTask'),
  durationMs: z.number().nonnegative(),
  t: z.number(),
});

export const AgentMessageSchema = z.discriminatedUnion('kind', [
  AgentStorageOpSchema,
  AgentRouteSchema,
  AgentWsSchema,
  AgentFrameworkDetectedSchema,
  AgentErrorSchema,
  AgentStateActionSchema,
  AgentStateCommitSchema,
  AgentPerfLongTaskSchema,
]);
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const AgentBatchSchema = z.object({
  v: z.literal(1),
  world: z.enum(['main', 'isolated']),
  /** Bootstrap handshake carries the guest's performance.now() origin so the
   *  host can rebase page timestamps onto the session clock (AD-4). */
  epochHint: z.number().optional(),
  messages: z.array(AgentMessageSchema).max(512),
});
export type AgentBatch = z.infer<typeof AgentBatchSchema>;

/** Host → command result for storage.state reads executed in-page. */
export const AgentStorageStateSchema = z.object({
  localStorage: z.array(z.object({ key: z.string(), value: z.string() })),
  sessionStorage: z.array(z.object({ key: z.string(), value: z.string() })),
});

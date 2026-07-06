import { z } from 'zod';
import { AssertionSchema } from './assertions.js';
import { CookieRecordSchema, MockPatternSchema, MockResponseSchema } from './capabilities.js';

/**
 * Committable `.localcoast/` artifact formats (AD-10). These files live in the
 * user's repo and are the compatibility contract across LocalCoast versions —
 * every format carries `version` and a `kind` discriminant.
 */

export const ARTIFACT_VERSION = 1;

// ---------------------------------------------------------------------------
// Port profiles — named workspace layouts
// ---------------------------------------------------------------------------

export const PortProfileSchema = z.object({
  version: z.literal(ARTIFACT_VERSION),
  kind: z.literal('portProfile'),
  name: z.string(),
  ports: z.array(
    z.object({
      port: z.number().int(),
      label: z.string().optional(),
    }),
  ),
  openPanels: z.array(z.string()).default([]),
  breakpoint: z
    .object({
      name: z.string().optional(),
      width: z.number().int(),
      height: z.number().int().optional(),
      rtl: z.boolean().default(false),
    })
    .optional(),
  pinnedSnapshots: z.array(z.string()).default([]),
});
export type PortProfile = z.infer<typeof PortProfileSchema>;

// ---------------------------------------------------------------------------
// Fixtures — mocks + auth + snapshot composed into one named action
// ---------------------------------------------------------------------------

export const FixtureSchema = z.object({
  version: z.literal(ARTIFACT_VERSION),
  kind: z.literal('fixture'),
  name: z.string(),
  description: z.string().optional(),
  mocks: z
    .array(z.object({ pattern: MockPatternSchema, response: MockResponseSchema }))
    .default([]),
  authTokens: z
    .array(
      z.object({
        token: z.string(),
        placement: z.enum(['localStorage', 'sessionStorage', 'cookie', 'authorizationHeader']),
        key: z.string(),
        cookieFlags: CookieRecordSchema.partial().optional(),
      }),
    )
    .default([]),
  /** Optional named snapshot restored as the fixture's app-state precondition. */
  snapshotName: z.string().optional(),
});
export type Fixture = z.infer<typeof FixtureSchema>;

// ---------------------------------------------------------------------------
// Assertion suites
// ---------------------------------------------------------------------------

export const AssertionSuiteSchema = z.object({
  version: z.literal(ARTIFACT_VERSION),
  kind: z.literal('assertionSuite'),
  name: z.string(),
  description: z.string().optional(),
  assertions: z.array(AssertionSchema).min(1),
});
export type AssertionSuite = z.infer<typeof AssertionSuiteSchema>;

// ---------------------------------------------------------------------------
// Scenarios — recorded, editable, deterministically replayable interactions
// ---------------------------------------------------------------------------

export const ScenarioStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('navigate'), url: z.string() }),
  z.object({
    action: z.literal('click'),
    selector: z.string(),
    button: z.enum(['left', 'middle', 'right']).default('left'),
  }),
  z.object({
    action: z.literal('type'),
    selector: z.string(),
    text: z.string(),
    pressEnter: z.boolean().default(false),
  }),
  z.object({ action: z.literal('waitFor'), assertion: AssertionSchema, timeoutMs: z.number().int().positive().default(10_000) }),
  z.object({ action: z.literal('snapshot'), name: z.string() }),
  z.object({ action: z.literal('pause'), ms: z.number().int().positive() }),
]);
export type ScenarioStep = z.infer<typeof ScenarioStepSchema>;

export const ScenarioSchema = z.object({
  version: z.literal(ARTIFACT_VERSION),
  kind: z.literal('scenario'),
  name: z.string(),
  description: z.string().optional(),
  steps: z.array(ScenarioStepSchema).min(1),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

// ---------------------------------------------------------------------------
// Snapshot document — persisted app-state snapshot (infra #5)
// ---------------------------------------------------------------------------

export const SnapshotDocumentSchema = z.object({
  version: z.literal(ARTIFACT_VERSION),
  kind: z.literal('snapshot'),
  snapshotId: z.string(),
  name: z.string().optional(),
  createdAtWall: z.number(),
  pinned: z.boolean().default(false),
  eventIdAtCapture: z.number().int().optional(),
  url: z.string(),
  storage: z.object({
    localStorage: z.record(z.string(), z.string()).default({}),
    sessionStorage: z.record(z.string(), z.string()).default({}),
  }),
  cookies: z.array(CookieRecordSchema).default([]),
  /** L3 store states — the reliable restore tier. */
  stores: z.array(z.object({ storeId: z.string(), state: z.unknown() })).default([]),
  /** L4 best-effort hook/instance state, matched by stable component path. */
  hookState: z
    .array(z.object({ componentPath: z.string(), state: z.unknown() }))
    .default([]),
  forms: z
    .array(z.object({ selector: z.string(), value: z.string(), checked: z.boolean().optional() }))
    .default([]),
  scroll: z.object({ x: z.number(), y: z.number() }).optional(),
  /** True when captured against a production build (L4 restore unavailable). */
  prodBuild: z.boolean().default(false),
});
export type SnapshotDocument = z.infer<typeof SnapshotDocumentSchema>;

export const AnyArtifactSchema = z.discriminatedUnion('kind', [
  PortProfileSchema,
  FixtureSchema,
  AssertionSuiteSchema,
  ScenarioSchema,
  SnapshotDocumentSchema,
]);
export type AnyArtifact = z.infer<typeof AnyArtifactSchema>;

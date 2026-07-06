import { z } from 'zod';

/**
 * Declarative assertion DSL (infra #14). Checks run against the
 * `session.observe` composite output. `select` is a dotted path into that
 * object with `[n]` index and `[*]` wildcard support — deliberately not full
 * JSONPath; the grammar stays small enough for agents to emit reliably.
 */

export const AssertionOpSchema = z.enum([
  'exists',
  'absent',
  'equals',
  'notEquals',
  'contains',
  'matches',
  'gt',
  'gte',
  'lt',
  'lte',
  'count',
]);
export type AssertionOp = z.infer<typeof AssertionOpSchema>;

export const AssertionSchema = z.object({
  id: z.string().optional(),
  description: z.string().optional(),
  /** e.g. `recentConsole[*].level`, `inFlightRequests`, `a11y.violations` */
  select: z.string(),
  op: AssertionOpSchema,
  /** Comparison operand; unused for exists/absent. For `count`, a number. */
  value: z.unknown().optional(),
});
export type Assertion = z.infer<typeof AssertionSchema>;

export const AssertionResultSchema = z.object({
  assertion: AssertionSchema,
  pass: z.boolean(),
  /** Serialized actual value at `select` (bounded size). */
  actual: z.unknown().optional(),
  error: z.string().optional(),
});
export type AssertionResult = z.infer<typeof AssertionResultSchema>;

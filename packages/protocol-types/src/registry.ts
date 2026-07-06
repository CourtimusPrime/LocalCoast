import type { z } from 'zod';

/**
 * Capability registry contract (AD-5). Every cross-surface feature is a
 * registered capability: Zod input/output schemas, a description that doubles
 * as the MCP tool description, and surface flags. The UI, the palette, and the
 * generated MCP tools are all thin clients of the same registry — there is no
 * other data path.
 */

export type CapabilityKind = 'query' | 'command' | 'subscription';

export interface CapabilitySurfaces {
  /** Defaults to true. Opting out requires `mcpExclusionReason` — CI enforces. */
  mcp: boolean;
  /** User-invokable from the command palette. */
  palette: boolean;
}

export interface CapabilityMeta {
  /** Dotted name, e.g. `network.list`, `act.navigate`, `session.observe`. */
  name: string;
  kind: CapabilityKind;
  /** Human/agent-facing description; becomes the MCP tool description verbatim. */
  description: string;
  surfaces: CapabilitySurfaces;
  /** Override for the generated MCP tool name; defaults to `lc_` + name with dots → underscores. */
  mcpName?: string;
  /** Required (and CI-checked) when surfaces.mcp is false. */
  mcpExclusionReason?: string;
  /** Palette entry title; required when surfaces.palette is true. */
  paletteTitle?: string;
}

export interface CapabilityDefinition<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> extends CapabilityMeta {
  input: I;
  output: O;
}

/** Wire shape of a subscription push. */
export interface SubscriptionMessage<T = unknown> {
  subscriptionId: string;
  data: T;
}

/** Default dotted-name → MCP tool name mapping (`network.list` → `lc_network_list`). */
export function defaultMcpToolName(capabilityName: string): string {
  return `lc_${capabilityName.replace(/[.-]/g, '_')}`;
}

/** Uniform error shape crossing every surface (IPC, MCP, palette). */
export interface CapabilityError {
  code:
    | 'not_found'
    | 'invalid_input'
    | 'invalid_output'
    | 'target_gone'
    | 'tier_unavailable'
    | 'timeout'
    | 'internal';
  message: string;
  details?: unknown;
}

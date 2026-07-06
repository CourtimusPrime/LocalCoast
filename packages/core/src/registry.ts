import { z } from 'zod';
import type { Actor, CapabilityDefinition, CapabilityMeta } from '@localcoast/protocol-types';

/**
 * Capability registry + typed dispatch (AD-5). Registration is where the
 * anti-drift invariants are mechanically enforced:
 *   - surfaces.mcp === false requires a written mcpExclusionReason
 *   - surfaces.palette === true requires a paletteTitle
 * The CI exposure check just loads the registry; violations throw here.
 */

export interface DispatchContext {
  actor: Actor;
}

export class CapabilityFault extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'invalid_input'
      | 'invalid_output'
      | 'target_gone'
      | 'tier_unavailable'
      | 'timeout'
      | 'internal',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CapabilityFault';
  }
}

export type QueryHandler<I extends z.ZodType, O extends z.ZodType> = (
  input: z.output<I>,
  ctx: DispatchContext,
) => Promise<z.input<O>> | z.input<O>;

export type SubscriptionHandler<I extends z.ZodType, O extends z.ZodType> = (
  input: z.output<I>,
  ctx: DispatchContext,
  emit: (data: z.input<O>) => void,
) => () => void;

interface RegisteredQuery<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType>
  extends CapabilityDefinition<I, O> {
  kind: 'query' | 'command';
  handler: QueryHandler<I, O>;
}

interface RegisteredSubscription<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType>
  extends CapabilityDefinition<I, O> {
  kind: 'subscription';
  handler: SubscriptionHandler<I, O>;
}

export type Registered = RegisteredQuery | RegisteredSubscription;

export interface RegisterInput<I extends z.ZodType, O extends z.ZodType> {
  name: string;
  description: string;
  input: I;
  output: O;
  surfaces?: Partial<CapabilityMeta['surfaces']>;
  mcpName?: string;
  mcpExclusionReason?: string;
  paletteTitle?: string;
}

function buildMeta<I extends z.ZodType, O extends z.ZodType>(
  kind: CapabilityMeta['kind'],
  def: RegisterInput<I, O>,
): CapabilityDefinition<I, O> {
  const surfaces = { mcp: def.surfaces?.mcp ?? true, palette: def.surfaces?.palette ?? false };
  if (!surfaces.mcp && !def.mcpExclusionReason) {
    throw new Error(
      `capability ${def.name}: opting out of MCP requires a written mcpExclusionReason (invariant 2)`,
    );
  }
  if (surfaces.palette && !def.paletteTitle) {
    throw new Error(`capability ${def.name}: palette surface requires a paletteTitle`);
  }
  return {
    name: def.name,
    kind,
    description: def.description,
    input: def.input,
    output: def.output,
    surfaces,
    mcpName: def.mcpName,
    mcpExclusionReason: def.mcpExclusionReason,
    paletteTitle: def.paletteTitle,
  };
}

export class CapabilityRegistry {
  private caps = new Map<string, Registered>();

  registerQuery<I extends z.ZodType, O extends z.ZodType>(
    def: RegisterInput<I, O> & { handler: QueryHandler<I, O> },
  ): void {
    this.add({ ...buildMeta('query', def), kind: 'query', handler: def.handler } as Registered);
  }

  registerCommand<I extends z.ZodType, O extends z.ZodType>(
    def: RegisterInput<I, O> & { handler: QueryHandler<I, O> },
  ): void {
    this.add({ ...buildMeta('command', def), kind: 'command', handler: def.handler } as Registered);
  }

  registerSubscription<I extends z.ZodType, O extends z.ZodType>(
    def: RegisterInput<I, O> & { handler: SubscriptionHandler<I, O> },
  ): void {
    this.add({
      ...buildMeta('subscription', def),
      kind: 'subscription',
      handler: def.handler,
    } as Registered);
  }

  private add(cap: Registered): void {
    if (this.caps.has(cap.name)) throw new Error(`capability ${cap.name} already registered`);
    this.caps.set(cap.name, cap);
  }

  get(name: string): Registered | undefined {
    return this.caps.get(name);
  }

  list(): Registered[] {
    return [...this.caps.values()];
  }
}

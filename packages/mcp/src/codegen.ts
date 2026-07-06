import { z } from 'zod';
import type { Core } from '@localcoast/core';
import { defaultMcpToolName } from '@localcoast/protocol-types';

/**
 * MCP tool codegen (AD-7): tools are GENERATED from the capability registry —
 * no hand-written tool bodies exist anywhere. Descriptions come verbatim from
 * registration; schemas convert Zod → JSON Schema at list time. Subscriptions
 * are skipped (MCP v1 surface is request/response only).
 */

export interface GeneratedTool {
  toolName: string;
  capabilityName: string;
  kind: 'query' | 'command';
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
}

export function generateTools(core: Core): GeneratedTool[] {
  const tools: GeneratedTool[] = [];
  for (const cap of core.registry.list()) {
    if (!cap.surfaces.mcp || cap.kind === 'subscription') continue;
    tools.push({
      toolName: cap.mcpName ?? defaultMcpToolName(cap.name),
      capabilityName: cap.name,
      kind: cap.kind,
      description: cap.description,
      inputSchema: toJsonSchema(cap.input),
      outputSchema: toJsonSchema(cap.output),
    });
  }
  const names = new Set<string>();
  for (const t of tools) {
    if (names.has(t.toolName)) throw new Error(`duplicate MCP tool name: ${t.toolName}`);
    names.add(t.toolName);
  }
  return tools;
}

/** Dispatch one generated tool call through Core with mcp actor attribution. */
export async function dispatchTool(
  core: Core,
  tools: GeneratedTool[],
  toolName: string,
  args: unknown,
): Promise<unknown> {
  const tool = tools.find((t) => t.toolName === toolName);
  if (!tool) throw new Error(`unknown tool: ${toolName}`);
  return tool.kind === 'command'
    ? core.command(tool.capabilityName, args, { actor: 'mcp' })
    : core.query(tool.capabilityName, args, { actor: 'mcp' });
}

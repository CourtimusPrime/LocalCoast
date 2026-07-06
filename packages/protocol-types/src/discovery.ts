import { z } from 'zod';

/**
 * MCP discovery file formats (AD-7). `instance.json` lives under
 * `~/.localcoast/` and is pid-staleness-checked by readers. The per-project
 * `.localcoast/mcp.json` is generated gitignored (committable artifacts live
 * beside it and are not ignored).
 */

export const InstanceInfoSchema = z.object({
  version: z.literal(1),
  url: z.string(),
  port: z.number().int(),
  pid: z.number().int(),
  token: z.string(),
  startedAtWall: z.number(),
});
export type InstanceInfo = z.infer<typeof InstanceInfoSchema>;

export const ProjectMcpConfigSchema = z.object({
  version: z.literal(1),
  url: z.string(),
  token: z.string(),
});
export type ProjectMcpConfig = z.infer<typeof ProjectMcpConfigSchema>;

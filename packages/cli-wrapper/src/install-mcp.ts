import { readInstanceInfo, writeProjectMcpConfig } from '@localcoast/mcp';

/**
 * Emit the one-liner that registers LocalCoast with an MCP client, and drop
 * the per-project discovery pointer (gitignored) into .localcoast/.
 */
export async function runInstallMcp(projectRoot: string = process.cwd()): Promise<void> {
  const instance = await readInstanceInfo();
  if (!instance) {
    console.error(
      'localcoast install-mcp: no running LocalCoast instance found. Start the app first so a token exists to install.',
    );
    process.exit(1);
  }

  const path = await writeProjectMcpConfig(projectRoot, {
    version: 1,
    url: instance.url,
    token: instance.token,
  });
  console.log(`Wrote ${path} (gitignored — carries this run's token).\n`);
  console.log('Register with Claude Code (HTTP, recommended):\n');
  console.log(
    `  claude mcp add --transport http localcoast ${instance.url} --header "Authorization: Bearer ${instance.token}"\n`,
  );
  console.log('Or for stdio-only clients:\n');
  console.log('  claude mcp add localcoast -- localcoast mcp-stdio\n');
}

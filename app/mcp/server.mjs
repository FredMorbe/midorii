import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOLS } from './tools.mjs';
import { researchClient } from './client.mjs';

export function createMcpServer(call) {
  const server = new McpServer({ name: 'midorii', version: '1.0.0' }, {
    instructions: 'Use Midorii for historical strategy research only. Never execute trades on real accounts, arm a live account, or start a live bot through any tool or UI. First inspect available datasets and strategy schemas. Create custom strategies as rule descriptors, then start backtests and poll their jobs. Report the tested data range, costs, trade count, and drawdown. A backtest does not establish future profitability.',
  });
  for (const [name, tool] of Object.entries(TOOLS)) {
    server.registerTool(name, { description: tool.description, inputSchema: tool.schema, annotations: tool.annotations }, async (args) => {
      try {
        const result = await call(name, args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] };
      }
    });
  }
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const index = process.argv.indexOf('--connection');
  const connectionFile = index >= 0 ? process.argv[index + 1]
    : fileURLToPath(new URL('../../.midorii/mcp.json', import.meta.url));
  if (!connectionFile) throw new Error('--connection needs a path');
  const server = createMcpServer(researchClient(connectionFile));
  await server.connect(new StdioServerTransport());
}

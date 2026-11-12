import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = path.join(root, '.codex');
const file = path.join(dir, 'config.toml');
const existing = await readFile(file, 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
if (/^\[mcp_servers\.midorii\]/m.test(existing)) {
  console.log('Midorii is already registered in this project.');
} else {
  const section = `\n[mcp_servers.midorii]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(path.join(root, 'app', 'mcp', 'server.mjs'))}]\nstartup_timeout_sec = 20\ntool_timeout_sec = 30\n`;
  await mkdir(dir, { recursive: true });
  await writeFile(file, `${existing.trimEnd()}\n${section}`, 'utf8');
  console.log('Registered Midorii in this project. Open a new Codex session to load its MCP tools.');
}

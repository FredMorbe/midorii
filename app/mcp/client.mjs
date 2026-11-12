import { readFile } from 'node:fs/promises';

export function researchClient(connectionFile) {
  return async (name, args) => {
    let connection;
    try { connection = JSON.parse(await readFile(connectionFile, 'utf8')); }
    catch { throw new Error('Midorii is not connected. Start Midorii from this checkout, then try again.'); }
    const url = new URL(connection.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/call'
      || url.username || url.password || url.search || url.hash || !url.port
      || typeof connection.token !== 'string' || !/^[a-f0-9]{64}$/.test(connection.token)) {
      throw new Error('Invalid local Midorii connection. Restart the app.');
    }
    let response;
    try {
      response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, arguments: args }) });
    } catch { throw new Error('Midorii did not respond. Check that the app is running and retry the status tool.'); }
    const message = await response.json();
    if (!response.ok) throw new Error(message.error ?? `Midorii returned HTTP ${response.status}`);
    return message.result;
  };
}

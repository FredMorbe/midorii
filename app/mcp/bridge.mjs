import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

/** Authenticated loopback transport for the fixed research tool surface. */
export async function startResearchBridge({ service, connectionFile }) {
  const token = randomBytes(32).toString('hex');
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    const answer = (status, data) => { response.writeHead(status); response.end(JSON.stringify(data)); };
    if (request.headers.origin !== undefined || request.headers.host !== `127.0.0.1:${server.address()?.port}`) {
      answer(403, { error: 'This connection accepts local MCP clients only.' }); return;
    }
    const supplied = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      answer(401, { error: 'Unauthorized' }); return;
    }
    if (request.method !== 'POST' || request.url !== '/call') { answer(404, { error: 'Unknown endpoint' }); return; }
    if (request.headers['content-type'] !== 'application/json') { answer(415, { error: 'JSON is required' }); return; }
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 262_144) { answer(413, { error: 'Request is too large' }); return; }
        chunks.push(chunk);
      }
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!message || typeof message !== 'object' || Array.isArray(message)
        || Object.keys(message).some((key) => key !== 'name' && key !== 'arguments')) throw new Error('Invalid tool request');
      answer(200, { result: await service.call(message.name, message.arguments ?? {}) });
    } catch (error) {
      if (!response.headersSent) answer(400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = new URL(`http://127.0.0.1:${server.address().port}/call`);
  try {
    await mkdir(path.dirname(connectionFile), { recursive: true });
    await writeFile(`${connectionFile}.tmp`, JSON.stringify({ url: address.href, token, pid: process.pid }), { mode: 0o600 });
    await rename(`${connectionFile}.tmp`, connectionFile);
  } catch (error) { server.close(); throw error; }
  return {
    async close() {
      const closing = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await Promise.all([closing, service.close()]);
      try {
        const current = JSON.parse(await readFile(connectionFile, 'utf8'));
        if (current.token === token) await unlink(connectionFile);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}

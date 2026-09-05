import { createServer, IncomingMessage, ServerResponse } from 'node:http';

import { formatScope, Scope, scopeHeaders } from '@mojaloop/authz/gateway';

import { config } from './config';
import { decide, NO_SCOPE } from './decide';
import { parsePayload } from './payload';

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString();
}

/** The single audit point: one record per decision, whichever way it went. */
const audit = (record: Record<string, unknown>): void => {
  console.log(JSON.stringify({ event: 'decision', ...record }));
};

const answer = (res: ServerResponse, allowed: boolean, scope: Scope): void => {
  res.writeHead(allowed ? 200 : 403, { 'Content-Type': 'application/json', ...scopeHeaders(scope) });
  res.end(JSON.stringify({ allowed }));
};

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const body = await readBody(req);

  let payload;
  try {
    payload = parsePayload(JSON.parse(body));
  } catch {
    payload = undefined;
  }
  if (payload === undefined) {
    audit({ allowed: false, reason: 'payload' });
    answer(res, false, NO_SCOPE);
    return;
  }

  try {
    const decision = await decide(payload);
    for (const tuple of decision.violations) {
      console.error(
        JSON.stringify({
          event: 'policy-violation',
          reason: 'grant written to a user instead of a role',
          tuple,
        }),
      );
    }
    const rows = [...decision.scope.values()].reduce((n, visible) => n + visible.ids.length, 0);
    if (rows > config.scopeAlarm) {
      console.error(JSON.stringify({ event: 'scope-alarm', rows, subject: payload.checks[0]!.subject_id }));
    }
    audit({
      allowed: decision.allowed,
      subject: payload.checks[0]!.subject_id,
      checks: payload.checks.map((c) => `${c.namespace}:${c.object}#${c.relation}`),
      scope: formatScope(decision.scope),
    });
    answer(res, decision.allowed, decision.scope);
  } catch (error) {
    // Keto is the only source of a verdict, so it being unreachable is a denial.
    console.error(JSON.stringify({ event: 'decision-error', error: String(error) }));
    audit({ allowed: false, reason: 'keto' });
    answer(res, false, NO_SCOPE);
  }
}

export const server = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error('Unhandled error:', error);
    res.writeHead(403, { 'Content-Type': 'application/json', ...scopeHeaders(NO_SCOPE) });
    res.end(JSON.stringify({ allowed: false }));
  });
});

export function start(): void {
  server.listen(config.port, () => {
    console.log(`Decision endpoint listening on port ${config.port}`);
    console.log(`Checking against: ${config.ketoReadUrl}`);
  });

  process.on('SIGINT', () => {
    server.close(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
}

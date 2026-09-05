import { IncomingMessage, ServerResponse } from 'node:http';

import { config } from './config';

interface Tuple {
  namespace: string;
  object: string;
  relation: string;
  subject_id?: string;
}

interface CapabilitiesRequest {
  tuples?: Tuple[];
}

interface CheckResult {
  allowed: boolean;
  error?: string;
}

interface KetoBatchResponse {
  results?: CheckResult[];
}

interface CapabilitiesResponse {
  results: CheckResult[];
}

interface ErrorResponse {
  error: string;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString();
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  data: CapabilitiesResponse | ErrorResponse | { status: string }
): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.url === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  // The caller asks which of its own permissions it holds. The subject comes
  // from the gateway-authenticated identity and any subject in the body is
  // discarded, so no caller can ask about anyone else.
  const subjectId = req.headers[config.subjectHeader];
  if (typeof subjectId !== 'string' || !subjectId) {
    sendJson(res, 401, { error: 'No authenticated subject' });
    return;
  }

  try {
    const body = await readBody(req);
    const { tuples } = JSON.parse(body) as CapabilitiesRequest;

    if (!Array.isArray(tuples)) {
      sendJson(res, 400, { error: 'Expected a tuples array' });
      return;
    }
    if (tuples.length === 0) {
      sendJson(res, 200, { results: [] });
      return;
    }

    const ketoResponse = await fetch(`${config.ketoReadUrl}/relation-tuples/batch/check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tuples: tuples.map(({ namespace, object, relation }) => ({
          namespace,
          object,
          relation,
          subject_id: subjectId,
        })),
      }),
    });

    if (!ketoResponse.ok) {
      const detail = await ketoResponse.text();
      console.error(`Keto batch check failed: ${ketoResponse.status} - ${detail}`);
      sendJson(res, 502, { error: 'Permission check failed' });
      return;
    }

    // Keto answers in request order, which is what lets the caller match each
    // result back to the permission it asked about
    const ketoData = (await ketoResponse.json()) as KetoBatchResponse;
    sendJson(res, 200, { results: ketoData.results || [] });
  } catch (error) {
    console.error('Capabilities error:', error);
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { Declared } from './reconcile';

/**
 * Where a document comes from.
 *
 * A chart mounts what it ships, and an operator writes a custom resource for
 * a surface that changes while the deployment runs. Both produce the same
 * thing, so the reconciler never learns which is which.
 */

/** A registration file: a document to read, and where its service is served. */
export interface Registration {
  name?: string;
  spec: string;
  host?: string;
  path?: string;
  url?: { host?: string; path?: string };
}

const parseDocument = (text: string, origin: string): unknown =>
  extname(origin) === '.json' ? JSON.parse(text) : parseYaml(text);

/**
 * The services a registry lists. A deployment's values name them under `authz`
 * and the file a chart mounts holds the list on its own, so both are read here
 * and everything downstream sees one shape.
 */
export const readRegistry = (text: string, origin: string): Registration[] => {
  const parsed = parseDocument(text, origin) as Registration[] | { authz?: Registration[] };
  return Array.isArray(parsed) ? parsed : (parsed?.authz ?? []);
};

/** The documents a chart mounted, read from a registry file listing them. */
export async function fromRegistry(file: string): Promise<Declared[]> {
  const entries = readRegistry(await readFile(file, 'utf8'), file);

  return Promise.all(
    entries.map(async (entry) => ({
      origin: entry.name ?? entry.spec,
      document: parseDocument(await readFile(entry.spec, 'utf8'), entry.spec),
      serving: { host: entry.host ?? entry.url?.host, path: entry.path ?? entry.url?.path },
    })),
  );
}

/** Every document in a directory, for a chart that mounts them side by side. */
export async function fromDirectory(dir: string): Promise<Declared[]> {
  const names = (await readdir(dir)).filter((name) => ['.yaml', '.yml', '.json'].includes(extname(name))).sort();

  return Promise.all(
    names.map(async (name) => ({
      origin: join(dir, name),
      document: parseDocument(await readFile(join(dir, name), 'utf8'), name),
      serving: {},
    })),
  );
}

/** The shape of an AuthzDocument, as its custom resource definition declares it. */
export interface AuthzDocumentResource {
  metadata?: { name?: string; generation?: number };
  spec?: {
    document?: string;
    url?: { host?: string; path?: string };
  };
}

/**
 * What a custom resource declares, read the same way a mounted file is. The
 * document is text inside the resource, because whoever writes it generated it
 * and has nowhere to put a file the platform can reach.
 */
export function fromResource(resource: AuthzDocumentResource): Declared {
  const name = resource.metadata?.name ?? '(unnamed)';
  const text = resource.spec?.document;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error(`AuthzDocument ${name}: spec.document is empty`);
  }
  return {
    origin: `AuthzDocument/${name}`,
    document: parseYaml(text),
    serving: { host: resource.spec?.url?.host, path: resource.spec?.url?.path },
  };
}

import { writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { stringify } from 'yaml';

import { compose, Composition, ResourceNames } from './compose';
import { derive } from './derive';
import { emitModel } from './emit-model';
import { emitRules, Serving } from './emit-rules';
import { ServiceBundle, ServiceCatalog } from './types';

export * from './compose';
export { derive } from './derive';
export { emitModel } from './emit-model';
export { emitRules, Serving } from './emit-rules';
export * from './types';

/**
 * Reads a document from disk: validated as OpenAPI and with every `$ref`
 * resolved, so a document split across files derives the same as one written
 * inline, and one that is not OpenAPI at all stops the rollout here.
 *
 * The parser answers what OpenAPI means; what `x-authz` means is read from
 * the package a service's own guard reads it with, so the deploy-time
 * conclusion and the runtime one cannot differ.
 */
export async function loadSpec(ref: string): Promise<unknown> {
  const { validate } = await import('@scalar/openapi-parser');
  const { valid, errors, schema, version } = await validate(await readFile(ref, 'utf8'), { throwOnError: false });

  if (!valid || schema === undefined) {
    const reasons = (errors ?? []).map((e) => e.message ?? String(e)).join('; ');
    throw new Error(`${ref}: is not a valid OpenAPI document${reasons ? `: ${reasons}` : ''}`);
  }
  if (!String(version).startsWith('3.')) {
    throw new Error(`${ref}: OpenAPI ${version} is not a version this platform speaks`);
  }

  const { dereference } = await import('@scalar/openapi-parser');
  const resolved = await dereference(schema);
  if (resolved.schema === undefined) {
    throw new Error(`${ref}: has references that do not resolve`);
  }
  return resolved.schema;
}

/**
 * The catalog the role UI reads: one entry per permission, carrying the text
 * a human sees and the resource slots a role must bind.
 */
export function emitCatalog(bundle: ServiceBundle): ServiceCatalog {
  return {
    service: bundle.service,
    title: bundle.title,
    basePath: bundle.basePath,
    resourceTypes: bundle.resourceTypes,
    permissions: bundle.permissions
      .filter((p) => !p.anonymous)
      .map((p) => ({
        id: p.id,
        relation: p.name,
        operationId: p.operationId,
        summary: p.summary,
        deprecated: p.deprecated,
        method: p.method,
        path: p.path,
        scopedBy: p.scopedBy.map((r) => r.type),
        bound: p.scopedBy.filter((r) => r.captureIndex !== undefined).map((r) => r.type),
        resourceNames: Object.fromEntries(
          p.scopedBy.filter((r) => r.resourceName !== undefined).map((r) => [r.type, r.resourceName!]),
        ),
      })),
  };
}

/**
 * The derivation table: what the generator concluded about every operation,
 * reviewed once per service and diffed on every build, so a wrong derivation
 * shows up as a changed line.
 */
export function emitDerivation(bundle: ServiceBundle): string {
  const rows = bundle.permissions.map((p) => {
    const bound = p.scopedBy.filter((r) => r.captureIndex !== undefined);
    const checks = p.anonymous
      ? 'anonymous'
      : bound.length === 0
        ? '__self__'
        : bound.map((r) => `${r.type}/{${r.param}}`).join(' + ');
    const scope = p.anonymous ? '' : `scope:${p.scopedBy.map((r) => r.type).join(',') || 'none'}`;
    return [p.method.padEnd(6), p.path.padEnd(52), p.id.padEnd(38), checks.padEnd(28), scope].join(' ');
  });
  const header = [
    `# ${bundle.service} — derived authorization surface`,
    `# ${bundle.permissions.length} operations, resource types: ${bundle.resourceTypes.join(', ') || 'none'}`,
    '',
  ];
  return [...header, ...rows, ''].join('\n');
}

export interface GenerateResult {
  bundle: ServiceBundle;
  rules: string;
  model: string;
  catalog: string;
  derivation: string;
}

/**
 * Stamps every scoped type with the resource name the deployment declared
 * for it. The rules check and the grants bind the resource name, so a scoped
 * type outside the vocabulary cannot generate.
 */
function nameScopes(bundle: ServiceBundle, names: ResourceNames): void {
  const byMember = new Map<string, string>();
  for (const [resourceName, declared] of Object.entries(names.resourceNames ?? {})) {
    for (const member of declared.members) byMember.set(`${member.service}.${member.type}`, resourceName);
  }
  for (const permission of bundle.permissions) {
    for (const arg of permission.scopedBy) {
      const resourceName = byMember.get(`${bundle.service}.${arg.type}`);
      if (resourceName === undefined) {
        throw new Error(
          `${bundle.service} is about ${arg.type}, and no resource name lists ${bundle.service}.${arg.type}`,
        );
      }
      arg.resourceName = resourceName;
    }
  }
}

export function generate(doc: unknown, serving: Serving = {}, names: ResourceNames = {}): GenerateResult {
  const serviceBundle = derive(doc);
  nameScopes(serviceBundle, names);
  return {
    bundle: serviceBundle,
    rules: stringify(emitRules(serviceBundle, serving), { lineWidth: 0 }),
    model: emitModel(serviceBundle),
    catalog: JSON.stringify(emitCatalog(serviceBundle), null, 2),
    derivation: emitDerivation(serviceBundle),
  };
}

/** Writes the generated bundle to a directory. */
export async function generateToDir(
  specPath: string,
  outDir: string,
  serving: Serving = {},
  names: ResourceNames = {},
): Promise<ServiceBundle> {
  const result = generate(await loadSpec(specPath), serving, names);
  await mkdir(outDir, { recursive: true });
  writeFileSync(join(outDir, 'oathkeeper-rules.yml'), result.rules);
  writeFileSync(join(outDir, 'keto-namespaces.ts'), result.model);
  writeFileSync(join(outDir, 'catalog.json'), result.catalog);
  writeFileSync(join(outDir, 'derivation.txt'), result.derivation);
  return result.bundle;
}

/** A service the deployment registered: where its document is, and where it is served. */
export interface ServiceRegistration {
  spec: string;
  host?: string;
  path?: string;
  url?: { host?: string; path?: string };
}

/**
 * Every registered service derived, checked against the others, and staged as
 * the files the gateway and Keto boot from. The rules stay one file per
 * service, because Oathkeeper reads a repository; the model is one file,
 * because Keto parses each file self-contained and would silently drop a whole
 * file's namespaces on a duplicated class name.
 */
export async function composeToDir(
  registry: ServiceRegistration[],
  outDir: string,
  names: ResourceNames = {},
): Promise<Composition> {
  const services = await Promise.all(
    registry.map(async (entry) => {
      const serving = { host: entry.host ?? entry.url?.host, path: entry.path ?? entry.url?.path };
      const result = generate(await loadSpec(entry.spec), serving, names);
      return {
        bundle: result.bundle,
        rules: result.rules,
        catalog: emitCatalog(result.bundle),
        derivation: result.derivation,
        ...serving,
      };
    }),
  );

  const composition = compose(services, names);

  await mkdir(join(outDir, 'rules'), { recursive: true });
  for (const [service, rules] of Object.entries(composition.rules)) {
    writeFileSync(join(outDir, 'rules', `${service}.yml`), rules);
  }
  writeFileSync(join(outDir, 'keto-namespaces.ts'), composition.model);
  writeFileSync(join(outDir, 'catalog.json'), `${JSON.stringify(composition.catalog, null, 2)}\n`);
  writeFileSync(join(outDir, 'derivation.txt'), composition.derivation);
  return composition;
}

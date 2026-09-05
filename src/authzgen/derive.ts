import { DeriveError, Permission, ScopedType, ServiceBundle } from './types';

/**
 * Derivation: an annotated OpenAPI document in, the authorization model of
 * that service out. The rules are fixed platform-wide, so two services with
 * the same shape always produce the same authorization structure.
 *
 *   permission id   <service>.<x-authz.permission ?? operationId>
 *   scoped by       x-authz.scopedBy ?? [the type of the outermost parameter]
 *   resource type   the literal segment preceding a path parameter
 *   bound type      a scoping type the path binds an id for; it is checked as
 *                   <type>/<id>, and every scoping type reaches the caller in
 *                   X-Scope whether bound or not
 *   singleton       an operation with no bound type, checked against __self__
 *   anonymous       native `security: []`
 *   authenticators  the security schemes, mapped by platform convention
 */

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace', 'query'];

/** Platform convention: an OpenAPI security scheme maps to one authenticator. */
export const AUTHENTICATOR_BY_SCHEME: Record<string, string> = {
  'apiKey:cookie': 'cookie_session',
  'http:bearer': 'jwt',
  'oauth2:': 'jwt',
  'openIdConnect:': 'jwt',
};

/** A written scopedBy entry: a bare type, or a type bound to a path parameter. */
type ScopedByEntry = string | Record<string, string>;

interface OperationAuthz {
  permission?: string;
  scopedBy?: ScopedByEntry[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Doc = any;

const segments = (path: string): string[] => path.split('/').filter(Boolean);

const paramName = (segment: string): string | undefined =>
  segment.startsWith('{') && segment.endsWith('}') ? segment.slice(1, -1) : undefined;

/** Path parameters in path order. */
export const pathParams = (path: string): string[] =>
  segments(path)
    .map(paramName)
    .filter((p): p is string => p !== undefined);


interface Binding {
  param: string;
  captureIndex: number;
}

/**
 * The resource types this path binds an id for, in path order: the literal
 * segment immediately preceding a parameter names the type, and the parameter
 * carries its id.
 *
 * Capture-group index 0 is the scheme group, so path captures start at 1;
 * every parameter consumes an index whether or not it names a type, and
 * disambiguation lookaheads are not capturing.
 */
export const boundTypes = (path: string): Map<string, Binding> => {
  const parts = segments(path);
  const bound = new Map<string, Binding>();
  let captureIndex = 1;
  parts.forEach((segment, at) => {
    const param = paramName(segment);
    if (param === undefined) return;
    const index = captureIndex++;
    const preceding = at > 0 ? parts[at - 1]! : undefined;
    if (preceding === undefined || paramName(preceding) !== undefined) return;
    if (!bound.has(preceding)) bound.set(preceding, { param, captureIndex: index });
  });
  return bound;
};

/**
 * Whether the operation answers with a list. A GET that does, and whose path
 * binds no resource id, returns rows nothing scopes unless it says what they
 * are, so the document has to say so.
 */
const returnsArray = (operation: Doc): boolean =>
  Object.entries(operation.responses ?? {}).some(
    ([status, response]) =>
      status.startsWith('2') &&
      Object.values((response as Doc).content ?? {}).some((media) => (media as Doc)?.schema?.type === 'array'),
  );

const readAuthz = (node: Doc, where: string): OperationAuthz => {
  const authz = node?.['x-authz'];
  if (authz === undefined) return {};
  if (typeof authz !== 'object' || Array.isArray(authz)) {
    throw new DeriveError(`${where}: x-authz must be an object`);
  }
  const known = new Set(['permission', 'scopedBy']);
  for (const key of Object.keys(authz)) {
    if (!known.has(key)) throw new DeriveError(`${where}: unknown x-authz key "${key}"`);
  }
  if (authz.permission !== undefined && typeof authz.permission !== 'string') {
    throw new DeriveError(`${where}: x-authz.permission must be a string`);
  }
  if (authz.scopedBy !== undefined) {
    if (!Array.isArray(authz.scopedBy)) {
      throw new DeriveError(`${where}: x-authz.scopedBy must be an array`);
    }
    for (const entry of authz.scopedBy) {
      if (typeof entry === 'string') continue;
      const pair = typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? Object.entries(entry) : [];
      if (pair.length !== 1 || typeof pair[0]![1] !== 'string') {
        throw new DeriveError(
          `${where}: a scopedBy entry is a type, or one \`type: parameter\` binding, got ${JSON.stringify(entry)}`,
        );
      }
    }
    const types = authz.scopedBy.map((e: ScopedByEntry) => (typeof e === 'string' ? e : Object.keys(e)[0]!));
    const duplicate = types.find((t: string, i: number) => types.indexOf(t) !== i);
    if (duplicate !== undefined) {
      throw new DeriveError(`${where}: x-authz.scopedBy lists "${duplicate}" twice`);
    }
  }
  return authz as OperationAuthz;
};

/**
 * A written scopedBy is the whole truth: a `type: parameter` entry binds that
 * parameter as the type's id, and a bare entry declares the type unbound. A
 * bare entry naming a type the path binds would read as bound and not be, so
 * it is refused.
 */
const scopedByOf = (
  entries: ScopedByEntry[],
  path: string,
  bound: Map<string, Binding>,
  where: string,
): ScopedType[] => {
  const params = pathParams(path);
  return entries.map((entry): ScopedType => {
    if (typeof entry === 'string') {
      const binding = bound.get(entry);
      if (binding !== undefined) {
        throw new DeriveError(
          `${where}: the path binds ${entry} through {${binding.param}}; write \`${entry}: ${binding.param}\` or a bare type the path does not bind`,
        );
      }
      return { type: entry };
    }
    const [type, param] = Object.entries(entry)[0]! as [string, string];
    const at = params.indexOf(param);
    if (at === -1) {
      throw new DeriveError(`${where}: scopedBy binds ${type} to {${param}}, which is not a parameter of this path`);
    }
    return { type, param, captureIndex: at + 1 };
  });
};

const authenticatorsFor = (security: Doc, schemes: Doc, where: string): string[] => {
  const handlers = new Set<string>();
  for (const requirement of security) {
    for (const scheme of Object.keys(requirement)) {
      const declared = schemes?.[scheme];
      if (!declared) throw new DeriveError(`${where}: security scheme "${scheme}" is not declared`);
      const key = `${declared.type}:${declared.type === 'apiKey' ? declared.in : declared.scheme ?? ''}`;
      const handler = AUTHENTICATOR_BY_SCHEME[key];
      if (!handler) {
        throw new DeriveError(`${where}: security scheme "${scheme}" (${key}) has no authenticator mapping`);
      }
      handlers.add(handler);
    }
  }
  return [...handlers];
};

/** The base path from the first server entry, without a trailing slash. */
export const basePathOf = (doc: Doc): string => {
  const url: string = doc.servers?.[0]?.url ?? '';
  const path = url.startsWith('http') ? new URL(url).pathname : url;
  return path === '/' ? '' : path.replace(/\/$/, '');
};

export function derive(doc: Doc): ServiceBundle {
  const root = doc['x-authz'] ?? {};
  for (const key of Object.keys(root)) {
    if (key !== 'service' && key !== 'resourceTypes') {
      throw new DeriveError(`the document root: unknown x-authz key "${key}"`);
    }
  }
  const service = root.service;
  if (typeof service !== 'string' || !service) {
    throw new DeriveError('the document root must declare x-authz.service');
  }
  // The name is a Keto namespace, and a namespace is a class in the staged
  // model, so anything a class cannot be named would make Keto drop the file.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(service)) {
    throw new DeriveError(`x-authz.service "${service}" is not a name a Keto namespace can take`);
  }
  if (
    root.resourceTypes !== undefined &&
    (!Array.isArray(root.resourceTypes) || root.resourceTypes.some((t: unknown) => typeof t !== 'string'))
  ) {
    throw new DeriveError('x-authz.resourceTypes must be an array of resource types');
  }
  const schemes = doc.components?.securitySchemes;
  const permissions: Permission[] = [];

  for (const [path, item] of Object.entries<Doc>(doc.paths ?? {})) {
    for (const method of METHODS) {
      const operation: Doc = item?.[method];
      if (!operation) continue;
      const where = `${method.toUpperCase()} ${path}`;

      const operationId: string = operation.operationId;
      if (!operationId) throw new DeriveError(`${where}: operationId is required`);
      if (!operation.summary) throw new DeriveError(`${where}: summary is required for the catalog`);
      if (operation.security === undefined) {
        throw new DeriveError(`${where}: security must be declared explicitly on every operation`);
      }

      const authz = readAuthz(operation, where);
      const bound = boundTypes(path);

      const anonymous = Array.isArray(operation.security) && operation.security.length === 0;
      if (method === 'get' && !anonymous && bound.size === 0 && authz.scopedBy === undefined && returnsArray(operation)) {
        throw new DeriveError(
          `${where}: returns a list and binds no resource id, so x-authz.scopedBy must name the row type, or be [] to declare the rows unscoped`,
        );
      }
      // By default an operation is about the resource its outermost parameter
      // identifies; types deeper in the path are business data inside it.
      // A type this document has no path for is legitimate: a service can
      // return rows about a resource it never routes. Whether the name is one
      // the deployment knows is checked where every service's types are
      // visible at once.
      const declared: ScopedType[] =
        authz.scopedBy !== undefined
          ? scopedByOf(authz.scopedBy, path, bound, where)
          : [...bound.entries()].slice(0, 1).map(([type, binding]) => ({ type, ...binding }));

      // Checks are emitted in capture order, so bound types sort by their
      // capture index and types the path does not bind follow them.
      const scopedBy: ScopedType[] = declared.sort(
        (a, b) => (a.captureIndex ?? Infinity) - (b.captureIndex ?? Infinity),
      );

      permissions.push({
        id: `${service}.${authz.permission ?? operationId}`,
        name: authz.permission ?? operationId,
        operationId,
        method: method.toUpperCase(),
        path,
        summary: operation.summary,
        deprecated: operation.deprecated === true,
        anonymous,
        authenticators: anonymous ? ['noop'] : authenticatorsFor(operation.security, schemes, where),
        scopedBy,
      });
    }
  }

  // A type is grantable in this service when some operation declares it. The
  // root list authors the same set, and checking the two against each other is
  // what catches a type one operation misspells among fifty.
  const resourceTypes = [...new Set(permissions.flatMap((p) => p.scopedBy.map((r) => r.type)))].sort();
  if (root.resourceTypes === undefined) {
    if (resourceTypes.length > 0) {
      throw new DeriveError(
        `the document is about [${resourceTypes.join(', ')}]; declare them in x-authz.resourceTypes at the root`,
      );
    }
  } else {
    const authored = new Set<string>(root.resourceTypes);
    for (const type of resourceTypes) {
      if (!authored.has(type)) {
        throw new DeriveError(`operations use resource type "${type}", which x-authz.resourceTypes does not declare`);
      }
    }
    for (const type of authored) {
      if (!resourceTypes.includes(type)) {
        throw new DeriveError(`x-authz.resourceTypes declares "${type}", which no operation uses`);
      }
    }
  }

  const ids = permissions.map((p) => p.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new DeriveError(`duplicate permission id "${duplicate}"`);

  return {
    service,
    title: doc.info?.title ?? service,
    basePath: basePathOf(doc),
    permissions,
    resourceTypes,
  };
}

import { Permission, ServiceBundle } from './types';

/**
 * Oathkeeper access rules, one per operation. Matches must be mutually
 * disjoint or Oathkeeper answers 500, so a templated segment that competes
 * with literal siblings at the same position carries a negative lookahead
 * listing them. Every rule is the same skeleton; only the payload varies.
 */

/** The mount and everything under it. */
const SUBTREE = '<(?:/.*)?>';

const segments = (path: string): string[] => path.split('/').filter(Boolean);
const paramName = (s: string): string | undefined =>
  s.startsWith('{') && s.endsWith('}') ? s.slice(1, -1) : undefined;

/**
 * Literal segments that appear at the same position, under the same prefix,
 * as this templated segment. Excluding them is what keeps `/things/{id}`
 * from also matching a sibling `/things/summary`.
 */
const competingLiterals = (path: string, index: number, allPaths: string[]): string[] => {
  const prefix = segments(path).slice(0, index);
  const literals = new Set<string>();
  for (const other of allPaths) {
    if (other === path) continue;
    const parts = segments(other);
    if (parts.length <= index) continue;
    const matchesPrefix = prefix.every((segment, i) => {
      const theirs = parts[i]!;
      return segment === theirs || paramName(segment) !== undefined || paramName(theirs) !== undefined;
    });
    if (!matchesPrefix) continue;
    const candidate = parts[index]!;
    if (paramName(candidate) === undefined) literals.add(candidate);
  }
  return [...literals].sort();
};

/**
 * Where the service is served. The document cannot know this, so the
 * deployment supplies it; without it the match keeps the placeholders for a
 * later substitution step.
 */
export interface Serving {
  host?: string;
  /** Mount path when the service is served under a prefix of a shared host. */
  path?: string;
}

/**
 * The host and mount a match is anchored at, both from the deployment: a
 * service given no mount path answers at the root of its host. A deployment
 * that named neither leaves the placeholders standing, for the step that
 * knows where the service runs to fill in.
 */
const anchor = (serving: Serving): { host: string; mount: string } => {
  const mount = serving.path?.replace(/\/$/, '');
  if (serving.host === undefined) return { host: '{host}', mount: mount ?? '{path}' };
  return { host: serving.host, mount: mount ?? '' };
};

/** Oathkeeper match expression for one operation. */
export const matchUrl = (
  permission: Permission,
  bundle: ServiceBundle,
  allPaths: string[],
  serving: Serving = {},
): string => {
  const parts = segments(permission.path).map((segment, index) => {
    const param = paramName(segment);
    if (param === undefined) return segment;
    const competing = competingLiterals(permission.path, index, allPaths);
    const guard = competing.length ? `<?!${competing.join('|')}>` : '';
    return `${guard}<(?<${param}>[^/]+)>`;
  });
  const path = parts.length ? `/${parts.join('/')}` : '';
  const { host, mount } = anchor(serving);
  // An operation at the root is the mount itself, and a mount owns the URL
  // space under it: one permission for an application whose own routes are
  // resolved past the gateway. An operation under a path answers at that path.
  const extent = parts.length ? '<$>' : SUBTREE;
  return `<http|https>://${host}${mount}${bundle.basePath}${path}${extent}`;
};

/**
 * A declared type the path binds an id for becomes a check on that resource,
 * addressed by its resource name — the platform's key for the real thing; an
 * operation binding none is checked against the service singleton. Every
 * declared type, bound or not, is asked for in `scope` under both spellings:
 * the resource name is what the grants hold, the type is what the caller's
 * service reads back in X-Scope.
 */
const payloadFor = (permission: Permission, service: string): string => {
  const check = (object: string) =>
    `{"namespace":"${service}","object":"${object}","relation":"${permission.name}","subject_id":"{{ print .Subject }}"}`;

  const checks = permission.scopedBy
    .filter((r) => r.captureIndex !== undefined)
    .map((r) => check(`${r.resourceName}/{{ printIndex .MatchContext.RegexpCaptureGroups ${r.captureIndex} }}`));

  const body = checks.length === 0 ? check('__self__') : checks.length === 1 ? checks[0]! : `{"allOf":[${checks.join(',')}]}`;

  const scope = permission.scopedBy
    .map((r) => `{"type":"${r.type}","resourceName":"${r.resourceName}"}`)
    .join(',');
  return `${body.slice(0, -1)},"scope":[${scope}]}`;
};

const rule = (
  permission: Permission,
  bundle: ServiceBundle,
  allPaths: string[],
  serving: Serving,
): unknown => {
  const match = { url: matchUrl(permission, bundle, allPaths, serving), methods: [permission.method] };
  if (permission.anonymous) {
    return {
      id: permission.id,
      match,
      authenticators: [{ handler: 'noop' }],
      authorizer: { handler: 'allow' },
      mutators: [{ handler: 'noop' }],
    };
  }
  return {
    id: permission.id,
    match,
    authenticators: permission.authenticators.map((handler) => ({ handler })),
    authorizer: {
      handler: 'remote_json',
      config: { payload: payloadFor(permission, bundle.service) },
    },
    mutators: [{ handler: 'noop' }],
  };
};

/** CORS preflights carry no credentials and are answered before authorization. */
const preflight = (bundle: ServiceBundle, serving: Serving): unknown => {
  const { host, mount } = anchor(serving);
  return {
    id: `${bundle.service}.preflight`,
    match: { url: `<http|https>://${host}${mount}${bundle.basePath}${SUBTREE}`, methods: ['OPTIONS'] },
    authenticators: [{ handler: 'noop' }],
    authorizer: { handler: 'allow' },
    mutators: [{ handler: 'noop' }],
  };
};

export function emitRules(bundle: ServiceBundle, serving: Serving = {}): unknown[] {
  const allPaths = [...new Set(bundle.permissions.map((p) => p.path))];
  return [preflight(bundle, serving), ...bundle.permissions.map((p) => rule(p, bundle, allPaths, serving))];
}

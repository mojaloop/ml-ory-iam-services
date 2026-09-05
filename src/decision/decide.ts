import { Scope, ScopeEntry } from '@mojaloop/authz/gateway';

import { check, query, Tuple } from './keto';
import { Check, Payload } from './payload';

/** Object ids and namespaces the platform fixes, because they live in stored tuples. */
export const TYPE_WIDE = '__all__';
export const SINGLETON = '__self__';
export const ROLE_NAMESPACE = 'Role';
export const MEMBERS = 'members';

/** What a service sees when the request carried no row filtering. */
export const NO_SCOPE: Scope = new Map();

export interface Decision {
  allowed: boolean;
  scope: Scope;
  violations: Tuple[];
}

const typeOf = (object: string): string | undefined => {
  const slash = object.indexOf('/');
  return slash > 0 ? object.slice(0, slash) : undefined;
};

/**
 * A grant on the type-wide object covers every resource of that type, present
 * and future, so it answers the same question as a grant on the resource
 * itself. The singleton has no wider form.
 */
const objectsFor = (object: string): string[] => {
  const type = typeOf(object);
  return type === undefined ? [object] : [object, `${type}/${TYPE_WIDE}`];
};

const passes = async (c: Check): Promise<boolean> => {
  for (const object of objectsFor(c.object)) {
    if (await check(c.namespace, object, c.relation, c.subject_id)) return true;
  }
  return false;
};

/** One role's grants, or the grants written straight to the caller. */
interface Holder {
  tuples: Tuple[];
  direct: boolean;
}

/**
 * Every grant the caller holds in one service namespace, reached the way
 * evaluation reaches it: through the caller's roles. Keto has no subject-first
 * index, so this walks. Evaluation honours a grant written straight to the
 * user, so the walk mirrors that path and reports one where it finds it.
 *
 * The grants stay grouped by what carries them, because a role is a statement
 * about one operation over one set of resources, and merging two roles would
 * invent combinations neither of them granted.
 */
async function grantHolders(namespace: string, subjectId: string): Promise<Holder[]> {
  const roles = await query({ namespace: ROLE_NAMESPACE, relation: MEMBERS, subject_id: subjectId });
  const held = await Promise.all(
    roles.map((role) =>
      query({
        namespace,
        'subject_set.namespace': ROLE_NAMESPACE,
        'subject_set.object': role.object,
        'subject_set.relation': MEMBERS,
      }),
    ),
  );
  const direct = await query({ namespace, subject_id: subjectId });
  const holders = held.map((tuples) => ({ tuples, direct: false }));
  return direct.length === 0 ? holders : [...holders, { tuples: direct, direct: true }];
}

/** Whether one holder carries every check the request had to pass. */
const admits = (holder: Holder, checks: Check[]): boolean =>
  checks.every((c) =>
    holder.tuples.some((t) => t.relation === c.relation && objectsFor(c.object).includes(t.object)),
  );

/**
 * The resources of one type the caller may see, defined as holding any grant
 * on the resource. That is exactly what this finds, so the header and a
 * per-resource check can never disagree.
 */
const overType = (tuples: Tuple[], type: string): ScopeEntry => {
  const prefix = `${type}/`;
  const ids = new Set<string>();
  let all = false;
  for (const tuple of tuples) {
    if (!tuple.object.startsWith(prefix)) continue;
    const id = tuple.object.slice(prefix.length);
    if (id === TYPE_WIDE) all = true;
    else ids.add(id);
  }
  return { all, ids: [...ids].sort() };
};

/**
 * Verdicts come only from Keto evaluating stored grants; this composes them.
 * Every allow carries a scope, so a service can tell an authorized request
 * from one that never passed through the gateway.
 */
export async function decide(payload: Payload): Promise<Decision> {
  const namespace = payload.checks[0]!.namespace;
  if (payload.checks.some((c) => c.namespace !== namespace)) {
    return { allowed: false, scope: NO_SCOPE, violations: [] };
  }

  for (const c of payload.checks) {
    if (!(await passes(c))) return { allowed: false, scope: NO_SCOPE, violations: [] };
  }

  if (payload.scope.length === 0) {
    return { allowed: true, scope: NO_SCOPE, violations: [] };
  }

  const holders = await grantHolders(namespace, payload.checks[0]!.subject_id);
  const violations = holders.filter((h) => h.direct).flatMap((h) => h.tuples);
  // Only what admitted this request says what it may see, so a role granting
  // one report for one participant cannot lend its participant to a report it
  // never granted.
  const tuples = holders.filter((h) => admits(h, payload.checks)).flatMap((h) => h.tuples);
  const visible: Scope = new Map();
  for (const pair of payload.scope) {
    // The grants hold the resource name; the caller's service reads its own
    // spelling back in X-Scope.
    const seen = overType(tuples, pair.resourceName);
    // A declared scope the caller has no standing in is a denial. An empty
    // list would read as "no restriction" in a query layer and return the
    // whole table, and on a write it would leave the caller unattributable.
    if (!seen.all && seen.ids.length === 0) {
      return { allowed: false, scope: NO_SCOPE, violations };
    }
    visible.set(pair.type, seen);
  }
  return { allowed: true, scope: visible, violations };
}

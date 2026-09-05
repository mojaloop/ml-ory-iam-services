import { MEMBERS, ROLE_NAMESPACE } from './materialize';
import { PermissionIndex, RoleDocument, RolesFile } from './roles';

/**
 * Separation of duties: permissions a deployment refuses to see in one pair of
 * hands, however many roles it takes to get there.
 *
 * The rule is between permissions, so it holds no matter which role carries
 * them, and it is checked wherever a holding is written: the administrator
 * making the combination is the one who can undo it.
 */

export interface Exclusion {
  /** What the rule is called, so a refusal names the policy it enforces. */
  name: string;
  a: string[];
  b: string[];
}

/** Every permission a set of roles grants, whatever resources they are over. */
export const permissionsOf = (roles: RoleDocument[]): string[] => [
  ...new Set(roles.flatMap((role) => role.grants.map((grant) => grant.permission))),
];

/**
 * The rules a holding breaks. A rule is broken when the holding reaches both
 * sides of it, and the report names the pair that reached them.
 */
export function broken(held: string[], exclusions: Exclusion[]): string[] {
  const holding = new Set(held);
  const problems: string[] = [];
  for (const rule of exclusions) {
    const fromA = rule.a.filter((id) => holding.has(id));
    const fromB = rule.b.filter((id) => holding.has(id));
    if (fromA.length > 0 && fromB.length > 0) {
      problems.push(`${rule.name}: ${fromA.join(',')} cannot be held with ${fromB.join(',')}`);
    }
  }
  return problems;
}

/** Roles by name, for a set of role names a subject holds. */
export const rolesNamed = (file: RolesFile, names: string[]): RoleDocument[] =>
  names.map((name) => file.roles[name]).filter((role): role is RoleDocument => role !== undefined);

/**
 * Who holds which roles, as the graph has it. An assignment made through the
 * IAM lives here and nowhere else.
 */
export async function heldRoles(keto: {
  query(params: Record<string, string>): Promise<Array<{ object: string; subject_id?: string }>>;
}): Promise<Map<string, string[]>> {
  const held = new Map<string, string[]>();
  for (const tuple of await keto.query({ namespace: ROLE_NAMESPACE, relation: MEMBERS })) {
    if (tuple.subject_id === undefined) continue;
    const at = tuple.object.indexOf('@');
    const role = at < 0 ? tuple.object : tuple.object.slice(0, at);
    held.set(tuple.subject_id, [...(held.get(tuple.subject_id) ?? []), role]);
  }
  return held;
}

/**
 * Every way an exclusion can be wrong before it ever refuses anything: a
 * permission no service advertises would be a rule that silently never fires,
 * and a single role granting both sides would be a rule nobody could satisfy
 * while holding it.
 */
export function validateExclusions(file: RolesFile, index: PermissionIndex): string[] {
  const problems: string[] = [];

  for (const rule of file.exclusions ?? []) {
    if (!rule.name) {
      problems.push('an exclusion has no name');
      continue;
    }
    for (const id of [...rule.a, ...rule.b]) {
      if (!index.has(id)) problems.push(`${rule.name}: unknown permission ${id}`);
    }
    if (rule.a.length === 0 || rule.b.length === 0) {
      problems.push(`${rule.name}: both sides need at least one permission`);
    }
  }

  for (const [name, role] of Object.entries(file.roles ?? {})) {
    for (const problem of broken(permissionsOf([role]), file.exclusions ?? [])) {
      problems.push(`role ${name} breaks ${problem}`);
    }
  }

  for (const assignment of file.assignments ?? []) {
    const held = (file.assignments ?? [])
      .filter((a) => a.subject === assignment.subject)
      .map((a) => a.role);
    for (const problem of broken(permissionsOf(rolesNamed(file, held)), file.exclusions ?? [])) {
      problems.push(`${assignment.subject} breaks ${problem}`);
    }
  }

  return [...new Set(problems)];
}

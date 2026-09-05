import { Migrations } from '../authzgen/compose';
import { filterFor, KetoWriter } from './keto';
import { Tuple } from './materialize';

/**
 * Moving the grants of a permission that a rollout renamed or retired.
 *
 * A role document is re-materialized on every rollout, so grants written from
 * it need nothing. What needs this is everything written since: a role
 * instance a service provisioned, a membership an operator granted in the UI.
 * Those hold the old relation, and nothing else would ever tell them.
 */

export interface Migrated {
  moved: number;
  retired: number;
}

const split = (id: string): { namespace: string; relation: string } => {
  const dot = id.indexOf('.');
  if (dot < 1) throw new Error(`${id} is not a <service>.<permission> id`);
  return { namespace: id.slice(0, dot), relation: id.slice(dot + 1) };
};

/** The same grant under the permission's new name. */
export const renamed = (tuple: Tuple, to: string): Tuple => {
  const { namespace, relation } = split(to);
  return { ...tuple, namespace, relation };
};

export async function migrate(keto: KetoWriter, migrations: Migrations): Promise<Migrated> {
  let moved = 0;
  let retired = 0;

  for (const [from, to] of Object.entries(migrations)) {
    const held = await keto.query(split(from));
    for (const tuple of held) {
      if (to !== null) {
        await keto.put(renamed(tuple, to));
        moved += 1;
      } else {
        retired += 1;
      }
      await keto.deleteWhere(filterFor(tuple));
    }
    console.log(`${from} -> ${to ?? 'retired'}: ${held.length} grants`);
  }

  return { moved, retired };
}

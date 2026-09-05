import { Tuple } from './materialize';

/**
 * Which resources exist, keyed by the deployment's resource name.
 *
 * A grant names a resource, so the graph knows every resource somebody can
 * already reach — and nothing about one nobody has been given yet. An operator
 * granting a report the day it is applied needs to be offered it by name, so a
 * resource says it exists when it is provisioned, in the one store the IAM
 * already has.
 *
 * The row grants nothing: it sits in its own namespace, under a relation no
 * rule ever checks, held by a subject that is not a principal.
 */

export const RESOURCE_NAMESPACE = 'Resource';
export const EXISTS = 'exists';
export const REGISTRY = '__registry__';
/**
 * The rows a declared source keeps. Its own marker is what lets it reconcile
 * without ever touching a row a service provisioned; every reader of the
 * registry accepts either marker.
 */
export const SOURCED = '__source__';

export const resourceObject = (resourceName: string, id: string): string => `${resourceName}/${id}`;

export const registryTuple = (resourceName: string, id: string): Tuple => ({
  namespace: RESOURCE_NAMESPACE,
  object: resourceObject(resourceName, id),
  relation: EXISTS,
  subject_id: REGISTRY,
});

export const sourcedTuple = (resourceName: string, id: string): Tuple => ({
  namespace: RESOURCE_NAMESPACE,
  object: resourceObject(resourceName, id),
  relation: EXISTS,
  subject_id: SOURCED,
});

export interface ResourceInstance {
  resourceName: string;
  id: string;
}

export const parseResource = (object: string): ResourceInstance | undefined => {
  const slash = object.indexOf('/');
  return slash > 0 ? { resourceName: object.slice(0, slash), id: object.slice(slash + 1) } : undefined;
};

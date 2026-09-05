import { readDocument } from '@mojaloop/authz/document';

import { accessRules, ResourceNames } from '../authzgen/compose';
import { AuthzDocument, listDocuments, publish, reportOn, watchDocuments } from './cluster';
import { Declared, reconcile, Reconciled } from './reconcile';
import { AuthzDocumentResource, fromRegistry, fromResource } from './sources';

/**
 * Publishes only when the whole composition holds together, so the last good
 * rules stay in force while a broken document is refused.
 */

export interface OperatorOptions {
  /** The namespace the documents and the published files live in. */
  namespace: string;
  /** A file listing the documents the chart mounted, and where each is served. */
  registry?: string;
  /** What the deployment says its services' vocabularies have in common. */
  names?: ResourceNames;
  /** The ConfigMap the gateway and Keto read. */
  publishAs?: string;
  /** Called with each accepted composition, for the IAM to serve. */
  onAccepted?: (result: Reconciled) => void | Promise<void>;
}

const stated = (resource: AuthzDocumentResource): { name: string; generation?: number } => ({
  name: resource.metadata?.name ?? '(unnamed)',
  generation: resource.metadata?.generation,
});

/** The service a document names, for `kubectl get` to show beside its state. */
const serviceIn = (resource: AuthzDocumentResource): string | undefined => {
  try {
    return readDocument(fromResource(resource).document).service;
  } catch {
    return undefined;
  }
};

export class Operator {
  private readonly options: OperatorOptions;
  private accepted?: Reconciled;
  private watcher?: { close: () => void };
  private running = false;
  private again = false;

  constructor(options: OperatorOptions) {
    this.options = options;
  }

  /** What the platform is currently serving, or nothing if it never accepted one. */
  get composition(): Reconciled | undefined {
    return this.accepted;
  }

  async start(): Promise<Reconciled> {
    const first = await this.run();
    this.watcher = await watchDocuments(this.options.namespace, async () => {
      await this.run();
    });
    return first;
  }

  stop(): void {
    this.watcher?.close();
  }

  /**
   * One pass. Overlapping calls collapse into one more pass afterwards, so a
   * burst of resources — an operator writing several at once — composes once,
   * from the set they settle at.
   */
  async run(): Promise<Reconciled> {
    if (this.running) {
      this.again = true;
      return this.accepted ?? { problems: ['a reconcile is already running'], origins: [] };
    }

    this.running = true;
    try {
      const result = await this.pass();
      return result;
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        await this.run();
      }
    }
  }

  private async pass(): Promise<Reconciled> {
    const resources = await listDocuments(this.options.namespace);
    const declared: Declared[] = [];
    const refused: { name: string; generation?: number; message: string }[] = [];

    for (const resource of resources) {
      try {
        declared.push(fromResource(resource));
      } catch (error) {
        refused.push({ ...stated(resource), message: (error as Error).message });
      }
    }

    if (this.options.registry !== undefined) {
      declared.push(...(await fromRegistry(this.options.registry)));
    }

    const result = reconcile(
      declared,
      this.options.names ?? {},
      this.accepted?.composition?.catalog,
    );

    await this.tell(resources, refused, result);

    if (result.composition === undefined) return result;

    this.accepted = result;
    if (this.options.publishAs !== undefined) {
      // Only what another pod mounts as a file. A ConfigMap holds a megabyte,
      // and the catalog, the derivation and the per-service rules are served
      // over the API by the process that composed them.
      await publish(this.options.namespace, this.options.publishAs, {
        'access-rules.yml': accessRules(result.composition.rules),
        'keto-namespaces.ts': result.composition.model,
      });
    }
    await this.options.onAccepted?.(result);
    return result;
  }

  /** Writes each document's fate back onto it, so its author can read it. */
  private async tell(
    resources: AuthzDocumentResource[],
    refused: { name: string; generation?: number; message: string }[],
    result: Reconciled,
  ): Promise<void> {
    const unreadable = new Map(refused.map((r) => [r.name, r.message]));

    for (const resource of resources) {
      const { name, generation } = stated(resource);
      const unreadableMessage = unreadable.get(name);
      const mine = result.problems.filter((problem) => problem.startsWith(`AuthzDocument/${name}:`));

      const messages = unreadableMessage !== undefined ? [unreadableMessage] : mine;
      const state = messages.length > 0 ? 'Refused' : result.composition === undefined ? 'Blocked' : 'Accepted';

      await reportOn(this.options.namespace, name, {
        state,
        service: serviceIn(resource),
        messages: state === 'Blocked' ? result.problems : messages,
        observedGeneration: generation,
      }).catch(() => undefined);
    }
  }
}

export type { AuthzDocument };

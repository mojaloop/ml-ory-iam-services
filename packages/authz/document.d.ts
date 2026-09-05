/** What one operation says about authorization, read from a document. */
export interface DeclaredOperation {
  operationId: string;
  /** `<service>.<permission>`, the id a grant names it by. */
  permission: string;
  method: string;
  /** The OpenAPI path template, before any base path. */
  template: string;
  summary: string;
  deprecated: boolean;
  anonymous: boolean;
  /** Whether the answer is a list of the rows a type names. */
  list: boolean;
  /** The resource types the answer is scoped by, and where the path carries an id. */
  scopedBy: { type: string; param?: string }[];
}

export interface ReadDocument {
  service: string;
  basePath: string;
  operations: DeclaredOperation[];
}

/** A document that cannot be read as an authorization surface. */
export class DocumentError extends Error {}

/** Reads a parsed document: its service, its base path and its operations. */
export function readDocument(doc: unknown): ReadDocument;

/** Reads a document from disk, YAML or JSON. */
export function loadDocument(file: string): Promise<unknown>;

/** The types the path itself carries an id for, by the segment naming them. */
export function boundTypes(template: string): Map<string, string>;

/** The base path from the first server entry, without a trailing slash. */
export function basePathOf(doc: unknown): string;

/** The HTTP methods an operation may be declared under. */
export const METHODS: string[];

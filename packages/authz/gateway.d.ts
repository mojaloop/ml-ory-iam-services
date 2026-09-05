/** What one decision says about one resource type. */
export interface ScopeEntry {
  /** Every id of the type, which renders as a wildcard. */
  all: boolean;
  /** The ids it names otherwise. */
  ids: string[];
}

/** A decision, by resource type. */
export type Scope = Map<string, ScopeEntry>;

/** The header a decision travels in. */
export const HEADER: 'x-scope';

/** What it says when the operation is scoped by nothing. */
export const NONE: 'none';

/** Renders a scope. */
export function formatScope(scope: Scope): string;

/** The headers an allow carries, named on this side only. */
export function scopeHeaders(scope: Scope): Record<string, string>;

/** Reads a scope back, for the round-trip the contract rests on. */
export function parseScope(headers: Record<string, string | undefined> | Headers | undefined): Scope;

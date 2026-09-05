'use strict';

/**
 * How the platform carries a decision from the endpoint that made it to the
 * service that answers under it.
 *
 * Private to this package. A service never sees any of it: it declares what
 * it guards and asks whether a request is allowed, and nothing in its code
 * says what a scope is or where it travels. Both directions live in one file
 * because a reader that parsed the format slightly differently from the
 * writer would be a silent data leak in that service rather than a parse
 * error.
 *
 *   widgets=*                       every resource of that type
 *   widgets=w7,w11                  those resources
 *   reports=monthly;widgets=w1      several types at once
 *   none                            no type is in play, nothing is visible
 */

/** The header this contract travels in. */
const HEADER = 'x-scope';

/** What the header says when the operation declared no resource type. */
const NONE = 'none';

/**
 * A call with no gateway in the path: one service calling another, a
 * background job, a test. It is passed by name, so an unrestricted read is
 * always something someone wrote rather than something that happened when a
 * scope went missing.
 */
const UNRESTRICTED = Symbol.for('@mojaloop/authz.INTERNAL');

/**
 * Renders a visible set per type. An entry marked `all` collapses to `*`;
 * everything else lists its ids.
 *
 * @param {Map<string, {all: boolean, ids: string[]}>} scope
 * @returns {string}
 */
const formatScope = (scope) => {
  const parts = [];
  for (const [type, visible] of scope) {
    parts.push(`${type}=${visible.all ? '*' : visible.ids.join(',')}`);
  }
  return parts.length === 0 ? NONE : parts.join(';');
};

/**
 * The headers an allow carries. Callers hand over a scope and never the name
 * it travels under, which is why a service cannot spell it one way while the
 * endpoint writing it spells it another.
 *
 * @param {Map<string, {all: boolean, ids: string[]}>} scope
 * @returns {Record<string, string>}
 */
const scopeHeaders = (scope) => ({ [HEADER]: formatScope(scope) });

/**
 * Reads a request's scope. Anything unparseable yields no types, which shows
 * nothing, because a header a service cannot read is not a licence to return
 * every row.
 *
 * @param {Record<string,string>|Headers|undefined} headers  the request's headers
 * @returns {Map<string, {all: boolean, ids: string[]}>}
 */
const parseScope = (headers) => {
  const raw = typeof headers?.get === 'function' ? headers.get(HEADER) : headers?.[HEADER];
  const scope = new Map();
  for (const part of String(raw ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const type = part.slice(0, eq).trim();
    const list = part.slice(eq + 1);
    scope.set(type, {
      all: list === '*',
      ids: list === '*' || list === '' ? [] : list.split(','),
    });
  }
  return scope;
};

/**
 * The ids of one type a caller may see, or undefined for no restriction. An
 * empty array means nothing is visible, which readers must not confuse with
 * undefined. Anything that is not a scope raises: the absence of a scope on a
 * request that reached the gateway means the request lost its authorization,
 * and returning every row would be the worst possible reading of that.
 *
 * @param {Map<string, {all: boolean, ids: string[]}>|symbol} scope
 * @param {string} type
 * @returns {string[]|undefined}
 */
const idsInScope = (scope, type) => {
  if (scope === UNRESTRICTED) return undefined;
  if (!(scope instanceof Map)) {
    throw new Error('no scope on this request; internal callers must pass UNRESTRICTED');
  }
  const visible = scope.get(type);
  if (!visible) return [];
  return visible.all ? undefined : visible.ids;
};

module.exports = { HEADER, NONE, UNRESTRICTED, formatScope, scopeHeaders, parseScope, idsInScope };

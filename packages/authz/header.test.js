'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { NONE, UNRESTRICTED, formatScope, scopeHeaders, parseScope, idsInScope } = require('./header');

const scope = (entries) => new Map(entries);

/**
 * The reason this file exists: the decision endpoint writes the header and
 * the guard reads it, so anything one produces the other must recover.
 */
test('every scope survives a round trip', () => {
  const cases = [
    scope([]),
    scope([['widgets', { all: true, ids: [] }]]),
    scope([['widgets', { all: false, ids: ['w7'] }]]),
    scope([['widgets', { all: false, ids: ['w7', 'w11', 'w42'] }]]),
    scope([
      ['reports', { all: false, ids: ['monthly', 'quarterly'] }],
      ['widgets', { all: true, ids: [] }],
    ]),
  ];
  for (const original of cases) {
    assert.deepEqual(parseScope(scopeHeaders(original)), original, `round trip of ${formatScope(original)}`);
  }
});

test('an empty scope is the none sentinel, not an empty string', () => {
  assert.equal(formatScope(scope([])), NONE);
  assert.equal(parseScope({ 'x-scope': NONE }).size, 0);
});

test('renders the shapes the guard reads on the wire', () => {
  assert.equal(formatScope(scope([['widgets', { all: true, ids: [] }]])), 'widgets=*');
  assert.equal(formatScope(scope([['widgets', { all: false, ids: ['w7', 'w11'] }]])), 'widgets=w7,w11');
  assert.equal(
    formatScope(
      scope([
        ['reports', { all: false, ids: ['monthly'] }],
        ['widgets', { all: true, ids: [] }],
      ]),
    ),
    'reports=monthly;widgets=*',
  );
});

test('an unreadable header shows nothing rather than everything', () => {
  for (const raw of [undefined, '', 'garbage', '=w7', ';;;', NONE]) {
    assert.equal(idsInScope(parseScope({ 'x-scope': raw }), 'widgets').length, 0, `for ${JSON.stringify(raw)}`);
  }
});

test('a type in the header but empty shows nothing', () => {
  assert.deepEqual(idsInScope(parseScope({ 'x-scope': 'widgets=' }), 'widgets'), []);
});

test('a wildcard is no restriction, an absent type is no rows', () => {
  assert.equal(idsInScope(parseScope({ 'x-scope': 'widgets=*' }), 'widgets'), undefined);
  assert.deepEqual(idsInScope(parseScope({ 'x-scope': 'reports=r1' }), 'widgets'), []);
});

test('undefined ids and an empty list are not the same answer', () => {
  const unrestricted = idsInScope(parseScope({ 'x-scope': 'widgets=*' }), 'widgets');
  const nothing = idsInScope(parseScope({ 'x-scope': 'widgets=' }), 'widgets');
  assert.equal(unrestricted, undefined);
  assert.deepEqual(nothing, []);
  assert.notEqual(unrestricted, nothing);
});

test('a call with no scope at all raises rather than defaulting open', () => {
  assert.throws(() => idsInScope(undefined, 'widgets'), /must pass UNRESTRICTED/);
  assert.throws(() => idsInScope(null, 'widgets'), /must pass UNRESTRICTED/);
  assert.throws(() => idsInScope({}, 'widgets'), /must pass UNRESTRICTED/);
});

test('a call with no gateway in its path says so by name', () => {
  assert.equal(idsInScope(UNRESTRICTED, 'widgets'), undefined);
});

test('the sentinel survives duplicate copies of the package', () => {
  assert.equal(UNRESTRICTED, Symbol.for('@mojaloop/authz.INTERNAL'));
});

test('ids containing no separator survive', () => {
  const original = scope([['widgets', { all: false, ids: ['a-b_c.d', 'UPPER'] }]]);
  assert.deepEqual(parseScope(scopeHeaders(original)), original);
});

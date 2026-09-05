'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createGuard, UNRESTRICTED, Forbidden, GuardError } = require('./index');

const doc = {
  openapi: '3.1.0',
  info: { title: 'Example', version: '1.0.0' },
  'x-authz': { service: 'example' },
  servers: [{ url: '/api' }],
  components: { securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'ory_kratos_session' } } },
  paths: {
    '/widgets': {
      get: {
        operationId: 'getWidgets',
        summary: 'Lists widgets',
        security: [{ session: [] }],
        'x-authz': { scopedBy: ['widgets'] },
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array' } } } } },
      },
    },
    '/widgets/{widgetId}/status': {
      get: {
        operationId: 'getWidgetStatus',
        summary: "Reads one widget's status",
        security: [{ session: [] }],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/health': {
      get: { operationId: 'getHealth', summary: 'Health', security: [], responses: { '200': { description: 'ok' } } },
    },
  },
};

const req = (url, scope, method = 'GET') => ({
  method,
  url,
  headers: scope === undefined ? {} : { 'x-scope': scope },
});

test('a caller nothing restricts sees everything', async () => {
  const guard = await createGuard(doc);
  const widgets = guard(req('/api/widgets', 'widgets=*'), 'widgets');
  assert.equal(widgets.restricted, false);
  assert.equal(widgets.allows('anything'), true);
  assert.deepEqual(widgets.narrow([{ id: 'w1' }, { id: 'w2' }], (row) => row.id), [{ id: 'w1' }, { id: 'w2' }]);
});

test('a caller holding some sees those, and narrows a list to them', async () => {
  const guard = await createGuard(doc);
  const widgets = guard(req('/api/widgets', 'widgets=w1,w3'), 'widgets');
  assert.equal(widgets.restricted, true);
  assert.deepEqual(widgets.ids, ['w1', 'w3']);
  assert.equal(widgets.allows('w1'), true);
  assert.equal(widgets.allows('w2'), false);
  assert.deepEqual(
    widgets.narrow([{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }], (row) => row.id),
    [{ id: 'w1' }, { id: 'w3' }],
  );
});

/**
 * The state a service forgets to ask about must be the safe one: a query
 * built from `ids` alone shows nothing rather than the whole table.
 */
test('the ids of an unrestricted caller are empty, not everything', async () => {
  const guard = await createGuard(doc);
  assert.deepEqual(guard(req('/api/widgets', 'widgets=*'), 'widgets').ids, []);
  assert.deepEqual(guard(UNRESTRICTED, 'widgets').ids, []);
});

test('a caller holding none is refused, with a status a framework can render', async () => {
  const guard = await createGuard(doc);
  assert.throws(
    () => guard(req('/api/widgets', 'reports=r1'), 'widgets'),
    (error) => error instanceof Forbidden && error.status === 403 && /no widgets/.test(error.message),
  );
});

test('a query string does not stop the operation being found', async () => {
  const guard = await createGuard(doc);
  assert.equal(guard(req('/api/widgets?limit=20&after=w1', 'widgets=*'), 'widgets').restricted, false);
});

test('an id the path carries belongs to a caller the gateway let through', async () => {
  const guard = await createGuard(doc);
  const widgets = guard(req('/api/widgets/w1/status', 'widgets=w1'), 'widgets');
  assert.deepEqual(widgets.ids, ['w1']);
});

test('a call with no gateway in its path passes the sentinel', async () => {
  const guard = await createGuard(doc);
  assert.equal(guard(UNRESTRICTED, 'widgets').restricted, false);
});

test('asking about a type the operation is not scoped by is a mistake in the service', async () => {
  const guard = await createGuard(doc);
  assert.throws(() => guard(req('/api/widgets', 'widgets=*'), 'reports'), GuardError);
});

test('a path the document does not describe is a mistake in the service', async () => {
  const guard = await createGuard(doc);
  assert.throws(() => guard(req('/api/nothing', 'widgets=*'), 'widgets'), GuardError);
});

test('the guard names the service its document declares', async () => {
  const guard = await createGuard(doc);
  assert.equal(guard.service, 'example');
});

test('a document that declares no service is refused at startup', async () => {
  await assert.rejects(() => createGuard({ ...doc, 'x-authz': {} }), /must declare x-authz.service/);
});

test('an unknown x-authz key is refused at startup', async () => {
  const bad = structuredClone(doc);
  bad.paths['/widgets'].get['x-authz'] = { resources: ['widgets'] };
  await assert.rejects(() => createGuard(bad), /unknown x-authz key/);
});

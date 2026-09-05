import { createServer } from 'node:http';

import request from 'supertest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('../../src/decision/config', () => ({
  config: { port: 3002, ketoReadUrl: 'http://keto-read-test', scopeAlarm: 500 },
}));

import { parsePayload } from '../../src/decision/payload';
import { handleRequest } from '../../src/decision/server';

const app = createServer((req, res) => {
  handleRequest(req, res).catch(() => {
    res.writeHead(403).end();
  });
});

const json = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

/**
 * Answers the Keto read API the way the running server does: a check by
 * whether the exact tuple was granted, a query by filtering the same store.
 */
const ketoStore = (tuples: Record<string, string[]>, roles: Record<string, string[]> = {}) => {
  const holderOf = (object: string, relation: string) => tuples[`${object}#${relation}`] ?? [];
  return (input: string) => {
    const url = new URL(input);
    if (url.pathname === '/relation-tuples/check') {
      const object = url.searchParams.get('object')!;
      const relation = url.searchParams.get('relation')!;
      const subject = url.searchParams.get('subject_id')!;
      const holders = holderOf(object, relation);
      const allowed = holders.includes(subject) || (roles[subject] ?? []).some((r) => holders.includes(r));
      return json({ allowed }, allowed ? 200 : 403);
    }
    if (url.pathname === '/relation-tuples') {
      const namespace = url.searchParams.get('namespace')!;
      const role = url.searchParams.get('subject_set.object');
      const subjectId = url.searchParams.get('subject_id');
      if (namespace === 'Role') {
        return json({
          relation_tuples: (roles[subjectId!] ?? []).map((object) => ({
            namespace: 'Role',
            object,
            relation: 'members',
            subject_id: subjectId,
          })),
        });
      }
      const wanted = role ?? subjectId!;
      const matches = Object.entries(tuples)
        .filter(([, holders]) => holders.includes(wanted))
        .map(([key]) => {
          const [object, relation] = key.split('#');
          return { namespace, object: object!, relation: relation! };
        });
      return json({ relation_tuples: matches });
    }
    throw new Error(`unexpected path ${url.pathname}`);
  };
};

const post = (body: unknown) => request(app).post('/').send(body as object);

describe('parsePayload', () => {
  const check = { namespace: 'mcm', object: 'dfsps/a', relation: 'updateDFSP', subject_id: 'u1' };

  it('reads a plain check', () => {
    expect(parsePayload(check)).toEqual({ checks: [check], scope: [] });
  });

  it('reads allOf with a scope', () => {
    const scope = [
      { type: 'reports', resourceName: 'Report' },
      { type: 'dfsps', resourceName: 'Participant' },
    ];
    expect(parsePayload({ allOf: [check, check], scope })).toEqual({
      checks: [check, check],
      scope,
    });
  });

  it.each([
    ['a non-object', 'nope'],
    ['an unknown key', { ...check, tenant: 'x' }],
    ['a missing field', { namespace: 'mcm', object: 'dfsps/a', relation: 'updateDFSP' }],
    ['an empty subject', { ...check, subject_id: '' }],
    ['an empty allOf', { allOf: [] }],
    ['allOf beside a check', { allOf: [check], ...check }],
    ['a scope that is not an array', { ...check, scope: 'dfsps' }],
    ['a scope holding a bare string', { ...check, scope: ['dfsps'] }],
    ['a scope pair missing its resource name', { ...check, scope: [{ type: 'dfsps' }] }],
    [
      'a scope listing a type twice',
      {
        ...check,
        scope: [
          { type: 'dfsps', resourceName: 'Participant' },
          { type: 'dfsps', resourceName: 'Participant' },
        ],
      },
    ],
  ])('rejects %s', (_label, raw) => {
    expect(parsePayload(raw)).toBeUndefined();
  });
});

describe('decision endpoint', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('reports health without asking Keto', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('denies an unparseable payload without asking Keto', async () => {
    const response = await post({ namespace: 'mcm' });
    expect(response.status).toBe(403);
    expect(response.headers['x-scope']).toBe('none');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('allows a check granted on the resource itself', async () => {
    mockFetch.mockImplementation(ketoStore({ 'dfsps/a#updateDFSP': ['u1'] }));
    const response = await post({ namespace: 'mcm', object: 'dfsps/a', relation: 'updateDFSP', subject_id: 'u1' });
    expect(response.status).toBe(200);
    expect(response.headers['x-scope']).toBe('none');
  });

  it('allows a check granted on the type-wide object', async () => {
    mockFetch.mockImplementation(ketoStore({ 'dfsps/__all__#updateDFSP': ['u1'] }));
    const response = await post({ namespace: 'mcm', object: 'dfsps/a', relation: 'updateDFSP', subject_id: 'u1' });
    expect(response.status).toBe(200);
  });

  it('resolves a grant held by the caller role', async () => {
    mockFetch.mockImplementation(ketoStore({ 'dfsps/a#updateDFSP': ['hub-admin'] }, { u1: ['hub-admin'] }));
    const response = await post({ namespace: 'mcm', object: 'dfsps/a', relation: 'updateDFSP', subject_id: 'u1' });
    expect(response.status).toBe(200);
  });

  it('denies a check granted on a different resource', async () => {
    mockFetch.mockImplementation(ketoStore({ 'dfsps/b#updateDFSP': ['u1'] }));
    const response = await post({ namespace: 'mcm', object: 'dfsps/a', relation: 'updateDFSP', subject_id: 'u1' });
    expect(response.status).toBe(403);
  });

  it('has no wider form for the service singleton', async () => {
    mockFetch.mockImplementation(ketoStore({ '__self__#getDFSPs': ['u1'] }));
    const response = await post({ namespace: 'mcm', object: '__self__', relation: 'getDFSPs', subject_id: 'u1' });
    expect(response.status).toBe(200);
    const checked = mockFetch.mock.calls.map(([u]) => new URL(u as string).searchParams.get('object'));
    expect(checked).toEqual(['__self__']);
  });

  it('allows allOf only when every check passes', async () => {
    const both = { 'dfsps/a#linkDfsp': ['u1'], 'reports/r1#linkDfsp': ['u1'] };
    const one = { 'dfsps/a#linkDfsp': ['u1'] };
    const payload = (store: Record<string, string[]>) => {
      mockFetch.mockImplementation(ketoStore(store));
      return post({
        allOf: [
          { namespace: 'mcm', object: 'reports/r1', relation: 'linkDfsp', subject_id: 'u1' },
          { namespace: 'mcm', object: 'dfsps/a', relation: 'linkDfsp', subject_id: 'u1' },
        ],
      });
    };
    expect((await payload(both)).status).toBe(200);
    mockFetch.mockReset();
    expect((await payload(one)).status).toBe(403);
  });

  it('delivers the caller visible rows as the scope, spelled the service way', async () => {
    mockFetch.mockImplementation(
      ketoStore(
        {
          '__self__#getDFSPs': ['viewer'],
          'Participant/b#getDFSPca': ['viewer'],
          'Participant/a#updateDFSP': ['viewer'],
          'Participant/z#updateDFSP': ['someone-else'],
        },
        { u1: ['viewer'] },
      ),
    );
    const response = await post({
      namespace: 'mcm',
      object: '__self__',
      relation: 'getDFSPs',
      subject_id: 'u1',
      scope: [{ type: 'dfsps', resourceName: 'Participant' }],
    });
    expect(response.status).toBe(200);
    expect(response.headers['x-scope']).toBe('dfsps=a,b');
  });

  it('collapses a resource-name-wide grant to a wildcard scope', async () => {
    mockFetch.mockImplementation(
      ketoStore({ '__self__#getDFSPs': ['admin'], 'Participant/__all__#updateDFSP': ['admin'], 'Participant/a#getDFSPca': ['admin'] }, { u1: ['admin'] }),
    );
    const response = await post({
      namespace: 'mcm',
      object: '__self__',
      relation: 'getDFSPs',
      subject_id: 'u1',
      scope: [{ type: 'dfsps', resourceName: 'Participant' }],
    });
    expect(response.headers['x-scope']).toBe('dfsps=*');
  });

  it('denies a listing whose visible set is empty', async () => {
    mockFetch.mockImplementation(ketoStore({ '__self__#getDFSPs': ['viewer'] }, { u1: ['viewer'] }));
    const response = await post({
      namespace: 'mcm',
      object: '__self__',
      relation: 'getDFSPs',
      subject_id: 'u1',
      scope: [{ type: 'dfsps', resourceName: 'Participant' }],
    });
    expect(response.status).toBe(403);
    expect(response.headers['x-scope']).toBe('none');
  });

  it('scopes a bound resource operation, so a write knows its caller', async () => {
    mockFetch.mockImplementation(
      ketoStore({ '__self__#postExternalCerts': ['dfsp-a-client'], 'Participant/a#updateDFSP': ['dfsp-a-client'] }, { m1: ['dfsp-a-client'] }),
    );
    const response = await post({
      namespace: 'mcm',
      object: '__self__',
      relation: 'postExternalCerts',
      subject_id: 'm1',
      scope: [{ type: 'dfsps', resourceName: 'Participant' }],
    });
    expect(response.status).toBe(200);
    expect(response.headers['x-scope']).toBe('dfsps=a');
  });

  it('joins several declared types into one header', async () => {
    mockFetch.mockImplementation(
      ketoStore(
        { '__self__#getReportRows': ['auditor'], 'Participant/a#updateDFSP': ['auditor'], 'Report/r1#getReport': ['auditor'] },
        { u1: ['auditor'] },
      ),
    );
    const response = await post({
      namespace: 'mcm',
      object: '__self__',
      relation: 'getReportRows',
      subject_id: 'u1',
      scope: [
        { type: 'reports', resourceName: 'Report' },
        { type: 'dfsps', resourceName: 'Participant' },
      ],
    });
    expect(response.status).toBe(200);
    expect(response.headers['x-scope']).toBe('reports=r1;dfsps=a');
  });

  it('denies when one declared type of several is empty', async () => {
    mockFetch.mockImplementation(
      ketoStore({ '__self__#getReportRows': ['auditor'], 'Report/r1#getReport': ['auditor'] }, { u1: ['auditor'] }),
    );
    const response = await post({
      namespace: 'mcm',
      object: '__self__',
      relation: 'getReportRows',
      subject_id: 'u1',
      scope: [
        { type: 'reports', resourceName: 'Report' },
        { type: 'dfsps', resourceName: 'Participant' },
      ],
    });
    expect(response.status).toBe(403);
    expect(response.headers['x-scope']).toBe('none');
  });

  /**
   * A role says what may be done and, for the same operation, over which
   * resources. Two roles are two such statements, so the resources of one must
   * not reach an operation only the other granted.
   */
  it('takes the scope from the roles that admitted the request', async () => {
    const store = ketoStore(
      {
        'Report/settlement#getReport': ['viewer@dfsp-a'],
        'Participant/dfsp-a#getReport': ['viewer@dfsp-a'],
        'Report/window#getReport': ['viewer@dfsp-b'],
        'Participant/dfsp-b#getReport': ['viewer@dfsp-b'],
      },
      { u1: ['viewer@dfsp-a', 'viewer@dfsp-b'] },
    );
    const run = (report: string) => {
      mockFetch.mockReset();
      mockFetch.mockImplementation(store);
      return post({
        namespace: 'reports',
        object: `Report/${report}`,
        relation: 'getReport',
        subject_id: 'u1',
        scope: [
          { type: 'reports', resourceName: 'Report' },
          { type: 'participants', resourceName: 'Participant' },
        ],
      });
    };

    const settlement = await run('settlement');
    expect(settlement.status).toBe(200);
    expect(settlement.headers['x-scope']).toBe('reports=settlement;participants=dfsp-a');

    const window = await run('window');
    expect(window.status).toBe(200);
    expect(window.headers['x-scope']).toBe('reports=window;participants=dfsp-b');

    const neither = await run('audit');
    expect(neither.status).toBe(403);
  });

  it('denies when Keto is unreachable', async () => {
    mockFetch.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const response = await post({ namespace: 'mcm', object: 'dfsps/a', relation: 'updateDFSP', subject_id: 'u1' });
    expect(response.status).toBe(403);
    expect(response.headers['x-scope']).toBe('none');
  });
});

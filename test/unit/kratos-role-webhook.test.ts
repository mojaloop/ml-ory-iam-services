import { createServer } from 'node:http';

import request from 'supertest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('../../src/kratos-role-webhook/config', () => ({
  config: {
    port: 8080,
    kratosAdminUrl: 'http://kratos-admin-test',
    ketoReadUrl: 'http://keto-read-test',
  },
}));

import { getUserRoles,handleRequest } from '../../src/kratos-role-webhook/handler';

const app = createServer((req, res) => {
  handleRequest(req, res).catch(() => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  });
});

describe('kratos-role-webhook', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('GET /health', () => {
    it('should return 200 with status healthy', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'healthy' });
    });
  });

  describe('getUserRoles', () => {
    it('should return roles from Keto including everyone', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          relation_tuples: [
            { object: 'admin' },
            { object: 'user' },
          ],
        }),
      });

      const roles = await getUserRoles('user-123');

      expect(roles).toContain('admin');
      expect(roles).toContain('user');
      expect(roles).toContain('everyone');
    });

    it('should return only everyone when Keto returns error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
      });

      const roles = await getUserRoles('user-123');

      expect(roles).toEqual(['everyone']);
    });

    it('should return only everyone on fetch error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const roles = await getUserRoles('user-123');

      expect(roles).toEqual(['everyone']);
    });
  });

  describe('POST /inject-roles', () => {
    it('should return 400 when missing required fields', async () => {
      const response = await request(app)
        .post('/inject-roles')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Missing required fields' });
    });

    it('should return 200 with roles on successful update', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            relation_tuples: [{ object: 'admin' }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            traits: { email: 'test@test.com' },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
        });

      const response = await request(app)
        .post('/inject-roles')
        .send({
          identity_id: 'identity-123',
          user_subject: 'user-123',
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.roles).toContain('admin');
      expect(response.body.roles).toContain('everyone');
    });

    it('should write roles to metadata_public and leave traits alone', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ relation_tuples: [{ object: 'hub-admin' }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              schema_id: 'default',
              state: 'active',
              traits: { email: 'test@test.com' },
              metadata_public: { dfspId: 'mtn' },
            }),
        })
        .mockResolvedValueOnce({ ok: true });

      await request(app)
        .post('/inject-roles')
        .send({ identity_id: 'identity-123', user_subject: 'user-123' });

      const update = JSON.parse(mockFetch.mock.calls[2][1].body as string);
      expect(update.metadata_public.roles).toContain('hub-admin');
      expect(update.metadata_public.dfspId).toBe('mtn');
      expect(update.traits).toEqual({ email: 'test@test.com' });
      expect(update.traits.roles).toBeUndefined();
    });

    it('should return 404 for unknown endpoints', async () => {
      const response = await request(app).post('/unknown');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Not found' });
    });
  });
});

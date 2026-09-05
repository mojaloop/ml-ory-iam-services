import { createServer } from 'node:http';

import request from 'supertest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('../../src/capabilities/config', () => ({
  config: {
    port: 3001,
    ketoReadUrl: 'http://keto-read-test',
    subjectHeader: 'x-user',
  },
}));

import { handleRequest } from '../../src/capabilities/handler';

const app = createServer((req, res) => {
  handleRequest(req, res).catch(() => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  });
});

const tuple = { namespace: 'Hub', object: 'mojaloop', relation: 'dfspManage' };

describe('capabilities', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('GET /health', () => {
    it('should return 200 with status ok', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });
  });

  describe('POST /', () => {
    it('should return 405 for non-POST methods', async () => {
      const response = await request(app).get('/');

      expect(response.status).toBe(405);
    });

    it('should return 401 without an authenticated subject', async () => {
      const response = await request(app).post('/').send({ tuples: [tuple] });

      expect(response.status).toBe(401);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return 400 when tuples is not an array', async () => {
      const response = await request(app).post('/').set('x-user', 'alice').send({});

      expect(response.status).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should answer an empty request without calling Keto', async () => {
      const response = await request(app).post('/').set('x-user', 'alice').send({ tuples: [] });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ results: [] });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should take the subject from the header and discard any in the body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ results: [{ allowed: true }] }),
      });

      await request(app)
        .post('/')
        .set('x-user', 'alice')
        .send({ tuples: [{ ...tuple, subject_id: 'mallory' }] });

      const sent = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(sent.tuples).toEqual([{ ...tuple, subject_id: 'alice' }]);
    });

    it('should return every result, denials included, in request order', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ results: [{ allowed: false }, { allowed: true }] }),
      });

      const response = await request(app)
        .post('/')
        .set('x-user', 'alice')
        .send({ tuples: [tuple, { ...tuple, relation: 'dfspList' }] });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ results: [{ allowed: false }, { allowed: true }] });
    });

    it('should return 502 when Keto rejects the check', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('batch exceeds max size'),
      });

      const response = await request(app)
        .post('/')
        .set('x-user', 'alice')
        .send({ tuples: [tuple] });

      expect(response.status).toBe(502);
    });
  });
});

const KETO_WRITE_URL = process.env.KETO_WRITE_URL || 'http://localhost:4467';
const KETO_BATCH_AUTH_URL = process.env.KETO_BATCH_AUTH_URL || 'http://localhost:3000';

interface HealthResponse {
  status: string;
}

interface AuthResponse {
  authorized: boolean;
}

describe('keto-batch-auth integration', () => {
  beforeAll(async () => {
    await fetch(`${KETO_WRITE_URL}/admin/relation-tuples`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace: 'role',
        object: 'admin',
        relation: 'member',
        subject_id: 'user-1',
      }),
    });
  });

  afterAll(async () => {
    await fetch(`${KETO_WRITE_URL}/admin/relation-tuples?namespace=role&object=admin&relation=member&subject_id=user-1`, {
      method: 'DELETE',
    });
  });

  describe('health check', () => {
    it('should return healthy', async () => {
      const response = await fetch(`${KETO_BATCH_AUTH_URL}/health`);
      expect(response.status).toBe(200);
      const data = await response.json() as HealthResponse;
      expect(data.status).toBe('ok');
    });
  });

  describe('batch authorization', () => {
    it('should return authorized when user has permission', async () => {
      const response = await fetch(KETO_BATCH_AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tuples: [
            {
              namespace: 'role',
              object: 'admin',
              relation: 'member',
              subject_id: 'user-1',
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const data = await response.json() as AuthResponse;
      expect(data.authorized).toBe(true);
    });

    it('should return unauthorized when user lacks permission', async () => {
      const response = await fetch(KETO_BATCH_AUTH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tuples: [
            {
              namespace: 'role',
              object: 'superadmin',
              relation: 'member',
              subject_id: 'user-1',
            },
          ],
        }),
      });

      expect(response.status).toBe(403);
      const data = await response.json() as AuthResponse;
      expect(data.authorized).toBe(false);
    });
  });
});

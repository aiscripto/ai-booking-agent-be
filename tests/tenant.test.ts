import { describe, expect, it, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import { createStaff, removeStaff, bearer, TestStaff } from './helpers/auth';
const app = require('../src/app').default || require('../src/app');

describe('Tenant & Industry Preset Endpoints Integration Tests', () => {
  const seedTenantId = '9eb441c7-f788-4137-8043-d4d7c3080879';
  let staff: TestStaff;

  beforeAll(async () => {
    staff = await createStaff(seedTenantId, 'FRONT_DESK');
  });

  afterAll(async () => {
    await removeStaff(staff);
  });

  describe('GET /api/v1/tenant/vocabulary', () => {
    it('should return Healthcare vocabulary mapping for seeded tenant', async () => {
      const response = await request(app)
        .get('/api/v1/tenant/vocabulary')
        .set(bearer(staff));

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data.industry).toBe('HEALTHCARE');
      expect(response.body.data.vocabulary.resourceLabel).toBe('Doctor / Specialist');
      expect(response.body.data.vocabulary.customerLabel).toBe('Patient');
      // Times are stored in UTC; the screens need the zone to show them correctly.
      expect(response.body.data.timeZone).toBe('America/New_York');
      expect(response.body.data.businessHours).toMatchObject({ start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] });
      expect(response.body.data.businessHours.weekly).toHaveLength(7);
    });

    it('should return 401 without a login token, even when a tenant_id is supplied', async () => {
      const response = await request(app).get(`/api/v1/tenant/vocabulary?tenant_id=${seedTenantId}`);
      expect(response.status).toBe(401);
    });
  });

  describe('GET & PUT /api/v1/tenant/branding', () => {
    it('should fetch tenant branding profile with resources and service types', async () => {
      const response = await request(app)
        .get('/api/v1/tenant/branding')
        .set(bearer(staff));

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('success');
      expect(response.body.data.name).toBe('City Care Medical Center');
      expect(Array.isArray(response.body.data.resources)).toBe(true);
      expect(Array.isArray(response.body.data.serviceTypes)).toBe(true);
      expect(response.body.data.timeZone).toBe('America/New_York');
    });
  });
});

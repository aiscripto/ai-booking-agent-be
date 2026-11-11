import request from 'supertest';
import { config } from '../src/config';
import app from '../src/app';
import { prisma } from '../src/services/db.service';
import { GoogleCalendarService } from '../src/services/google-calendar.service';
import { TenantScheduleService } from '../src/services/tenant-schedule.service';
import { toolResult } from './helpers/voice';

jest.mock('../src/services/google-calendar.service', () => ({
  GoogleCalendarService: { checkAvailability: jest.fn(), createEvent: jest.fn(), deleteEvent: jest.fn(), getBusyIntervals: jest.fn() },
}));

// The shapes Vapi and Retell really send, and what each one needs back (checked against their documentation).
describe('Voice platform formats (Vapi and Retell)', () => {
  const tenantId = '3f1c8a52-0b7d-4c1e-9a55-6d2e7b1f1c01';
  const key = config.WEBHOOK_API_KEY;
  const monday = '2031-01-06';
  const url = (extra = '') => `/api/v1/voice/webhook?tenant_id=${tenantId}&calendar_id=primary${extra}`;

  beforeAll(async () => {
    await prisma.tenant.upsert({ where: { id: tenantId }, update: {}, create: { id: tenantId, name: 'Formats Test', industry: 'HEALTHCARE' } });
  });
  beforeEach(async () => {
    TenantScheduleService.clearAll();
    (GoogleCalendarService.checkAvailability as jest.Mock).mockResolvedValue(true);
    (GoogleCalendarService.createEvent as jest.Mock).mockResolvedValue('evt');
    (GoogleCalendarService.getBusyIntervals as jest.Mock).mockResolvedValue([]);
    await prisma.appointment.deleteMany({ where: { tenantId } });
  });
  afterAll(async () => {
    await prisma.appointment.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } });
  });

  describe('Vapi', () => {
    const vapi = (calls: object[], list: 'toolCallList' | 'toolCalls' = 'toolCallList') => ({ message: { type: 'tool-calls', [list]: calls, call: { id: 'call-1' } } });

    it('reads message.toolCallList and answers each call with a single-line string result', async () => {
      const res = await request(app)
        .post(url())
        .set('x-api-key', key)
        .send(vapi([{ id: 'tc-1', type: 'function', function: { name: 'checkAvailability', arguments: { dateTime: `${monday}T10:00:00` } } }]));
      expect(res.status).toBe(200);
      expect(res.body.results[0].toolCallId).toBe('tc-1');
      expect(typeof res.body.results[0].result).toBe('string');
      expect(res.body.results[0].result).not.toContain('\n');
      expect(toolResult(res).available).toBe(true);
    });

    it('accepts arguments written as a JSON string, and the older toolCalls list', async () => {
      const res = await request(app)
        .post(url())
        .set('x-api-key', key)
        .send(vapi([{ id: 'tc-2', function: { name: 'checkAvailability', arguments: JSON.stringify({ dateTime: `${monday}T10:30:00` }) } }], 'toolCalls'));
      expect(toolResult(res).available).toBe(true);
    });

    it('answers several calls in one request, each with its own id', async () => {
      const res = await request(app)
        .post(url())
        .set('x-api-key', key)
        .send(vapi([
          { id: 'a', name: 'listConsultants', parameters: {} },
          { id: 'b', function: { name: 'getAvailableTimes', arguments: { date: monday, limit: 3 } } },
        ]));
      expect(res.body.results.map((r: { toolCallId: string }) => r.toolCallId)).toEqual(['a', 'b']);
      expect(JSON.parse(res.body.results[1].result).availableSlotsIso).toHaveLength(3);
    });

    it('accepts the key as Authorization: Bearer and as x-vapi-secret, and refuses a wrong one', async () => {
      const body = vapi([{ id: 'k', function: { name: 'listConsultants', arguments: {} } }]);
      expect((await request(app).post(url()).set('Authorization', `Bearer ${key}`).send(body)).status).toBe(200);
      expect((await request(app).post(url()).set('x-vapi-secret', key).send(body)).status).toBe(200);
      expect((await request(app).post(url()).set('x-vapi-secret', 'wrong').send(body)).status).toBe(401);
      expect((await request(app).post(url()).send(body)).status).toBe(401);
    });
  });

  describe('Retell', () => {
    it('reads { name, args, call } and returns the answer as a JSON object', async () => {
      const res = await request(app)
        .post(url())
        .set('x-api-key', key)
        .send({ name: 'bookAppointment', args: { dateTime: `${monday}T11:00:00`, customerName: 'Rita Retell', customerPhone: '555-0123' }, call: { call_id: 'r-1' } });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/booked for Rita Retell on .*11:00 AM EST/);
    });

    it('"args only" payloads name the tool in the web address (?tool=)', async () => {
      const times = await request(app).post(url('&tool=getAvailableTimes')).set('x-api-key', key).send({ date: monday });
      expect(times.body.availableSlotsIso.length).toBeGreaterThan(0);
      const list = await request(app).post(url('&tool=listConsultants')).set('x-api-key', key).send({});
      expect(list.body).toMatchObject({ success: true, consultants: [], categories: [] });
      const book = await request(app).post(url('&tool=bookAppointment')).set('x-api-key', key).send({ dateTime: `${monday}T12:00:00`, customerName: 'Ari Args', customerPhone: '555-0124' });
      expect(book.body.success).toBe(true);
      expect((await request(app).post(url('&tool=notATool')).set('x-api-key', key).send({})).status).toBe(400);
    });
  });

  it('getAvailableTimes refuses a date that does not exist, and does not invent times', async () => {
    const res = await request(app)
      .post(url())
      .set('x-api-key', key)
      .send({ message: { type: 'tool-calls', toolCallList: [{ id: 'x', function: { name: 'getAvailableTimes', arguments: { date: '2031-02-30' } } }] } });
    expect(toolResult(res)).toMatchObject({ success: false });
    const sunday = await request(app).post(url('&tool=getAvailableTimes')).set('x-api-key', key).send({ date: '2031-01-12' });
    expect(sunday.body).toMatchObject({ closed: true, availableSlotsIso: [] });
  });
});

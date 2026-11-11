import { bookableSlot } from './helpers/time';
import { toolResult } from './helpers/voice';
import request from 'supertest';
import app from '../src/app';
import { prisma } from '../src/services/db.service';
import { GoogleCalendarService } from '../src/services/google-calendar.service';

// Two tests book this same time on purpose (the second must be refused as a double booking).
const sharedBookingTime = bookableSlot();

// Mock the Google Calendar Service
jest.mock('../src/services/google-calendar.service', () => {
  return {
    GoogleCalendarService: {
      checkAvailability: jest.fn(),
      createEvent: jest.fn(),
      deleteEvent: jest.fn(),
    },
  };
});

describe('Voice Webhook Endpoints Integration Tests', () => {
  jest.setTimeout(30000);
  let tenantId: string;
  const calendarId = 'test-calendar-id';
  const apiKey = require('../src/config').config.WEBHOOK_API_KEY;


  // This suite has its own tenant. It used to take "the first tenant in the database", which in a
  // shared test database could be another suite's tenant, and its cleanup then deleted that
  // suite's appointments and call logs while it was still running.
  const ownTenantId = '3f1c8a52-0b7d-4c1e-9a55-6d2e7b1f1801';

  beforeAll(async () => {
    await prisma.tenant.upsert({
      where: { id: ownTenantId },
      update: {},
      create: { id: ownTenantId, name: 'Voice Test Tenant', industry: 'HEALTHCARE' },
    });
    tenantId = ownTenantId;
    await prisma.callLog.deleteMany({ where: { tenantId } });
    await prisma.appointment.deleteMany({ where: { tenantId } });
  });

  afterAll(async () => {
    // Remove only this suite's own data, then release the database connections.
    await prisma.callLog.deleteMany({ where: { tenantId } });
    await prisma.appointment.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { id: ownTenantId } });
    await prisma.$disconnect();
  });

  describe('Security & Validation', () => {
    it('should return 401 Unauthorized if API Key is missing', async () => {
      const response = await request(app)
        .post(`/api/v1/voice/webhook?tenant_id=${tenantId}&calendar_id=${calendarId}`)
        .send({});

      expect(response.status).toBe(401);
      expect(response.body.message).toContain('Unauthorized');
    });

    it('should return 400 Bad Request if tenant_id is an invalid UUID', async () => {
      const response = await request(app)
        .post(`/api/v1/voice/webhook?tenant_id=invalid-uuid&calendar_id=${calendarId}`)
        .set('x-api-key', apiKey)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.message).toContain('Validation failed');
    });
  });

  describe('Tool Calling Orchestration', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should successfully evaluate checkAvailability tool', async () => {
      // Mock Google Calendar to say slot is available
      (GoogleCalendarService.checkAvailability as jest.Mock).mockResolvedValue(true);

      const targetTime = bookableSlot();

      const response = await request(app)
        .post(`/api/v1/voice/webhook?tenant_id=${tenantId}&calendar_id=${calendarId}`)
        .set('x-api-key', apiKey)
        .send({
          message: {
            type: 'tool-calls',
            toolCalls: [
              {
                id: 'call-check-01',
                type: 'function',
                function: {
                  name: 'checkAvailability',
                  arguments: {
                    dateTime: targetTime.toISOString(),
                  },
                },
              },
            ],
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.results).toBeDefined();
      expect(response.body.results[0].toolCallId).toBe('call-check-01');
      expect(toolResult(response).available).toBe(true);
      expect(GoogleCalendarService.checkAvailability).toHaveBeenCalled();
    });

    it('should successfully book an appointment locally even if calendar creation fails in background', async () => {
      // Mock calendar to be available
      (GoogleCalendarService.checkAvailability as jest.Mock).mockResolvedValue(true);
      // Mock calendar event creation to throw error to trigger DB rollback
      (GoogleCalendarService.createEvent as jest.Mock).mockRejectedValue(
        new Error('Google Service Unavailable')
      );

      const bookingTime = bookableSlot();

      const response = await request(app)
        .post(`/api/v1/voice/webhook?tenant_id=${tenantId}&calendar_id=${calendarId}`)
        .set('x-api-key', apiKey)
        .send({
          message: {
            type: 'tool-calls',
            toolCalls: [
              {
                id: 'call-book-01',
                type: 'function',
                function: {
                  name: 'bookAppointment',
                  arguments: {
                    dateTime: bookingTime.toISOString(),
                    customerName: 'Test Patient',
                    customerPhone: '555-0199',
                    customerEmail: 'patient@example.com',
                  },
                },
              },
            ],
          },
        });

      expect(response.status).toBe(200);
      expect(toolResult(response).success).toBe(true);
      expect(toolResult(response).appointmentId).toBeDefined();

      // Wait for background task to catch and finish
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify DB record exists and has null googleEventId
      const appointment = await prisma.appointment.findFirst({
        where: {
          tenantId,
          calendarId,
          appointmentDateTime: bookingTime,
        },
      });
      expect(appointment).not.toBeNull();
      expect(appointment?.customerName).toBe('Test Patient');
      expect(appointment?.googleEventId).toBeNull();
    });

    it('should book appointment, write to DB and sync with Google Calendar successfully', async () => {
      // Mock calendar is available
      (GoogleCalendarService.checkAvailability as jest.Mock).mockResolvedValue(true);
      // Mock calendar event creation returns mock ID
      (GoogleCalendarService.createEvent as jest.Mock).mockResolvedValue('gcal-event-uuid-123');

      const bookingTime = sharedBookingTime; // the next test books this same time again

      const response = await request(app)
        .post(`/api/v1/voice/webhook?tenant_id=${tenantId}&calendar_id=${calendarId}`)
        .set('x-api-key', apiKey)
        .send({
          message: {
            type: 'tool-calls',
            toolCalls: [
              {
                id: 'call-book-02',
                type: 'function',
                function: {
                  name: 'bookAppointment',
                  arguments: {
                    dateTime: bookingTime.toISOString(),
                    customerName: 'Alice Smith',
                    customerPhone: '555-0200',
                    customerEmail: 'alice@example.com',
                  },
                },
              },
            ],
          },
        });

      expect(response.status).toBe(200);
      expect(toolResult(response).success).toBe(true);
      expect(toolResult(response).appointmentId).toBeDefined();

      // Wait for background sync to complete (max 1 second)
      let appointment = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        appointment = await prisma.appointment.findFirst({
          where: {
            tenantId,
            calendarId,
            appointmentDateTime: bookingTime,
          },
        });
        if (appointment?.googleEventId) {
          break;
        }
      }

      expect(appointment).not.toBeNull();
      expect(appointment?.customerName).toBe('Alice Smith');
      expect(appointment?.googleEventId).toBe('gcal-event-uuid-123');
    });

    it('should enforce DB level atomic constraint and fail on double-booking', async () => {
      // We already booked bookingTime+72 (Alice Smith) in the previous test.
      // Let's attempt to book it again.
      // Mock calendar is available (simulate race condition where calendar isn't updated yet but local DB is)
      (GoogleCalendarService.checkAvailability as jest.Mock).mockResolvedValue(true);

      const bookingTime = sharedBookingTime;

      const response = await request(app)
        .post(`/api/v1/voice/webhook?tenant_id=${tenantId}&calendar_id=${calendarId}`)
        .set('x-api-key', apiKey)
        .send({
          message: {
            type: 'tool-calls',
            toolCalls: [
              {
                id: 'call-book-03',
                type: 'function',
                function: {
                  name: 'bookAppointment',
                  arguments: {
                    dateTime: bookingTime.toISOString(),
                    customerName: 'Bob Jones',
                    customerPhone: '555-9999',
                  },
                },
              },
            ],
          },
        });

      expect(response.status).toBe(200);
      // It should fail because the unique constraint throws an error and rejects double booking.
      expect(toolResult(response).success).toBe(false);
      expect(toolResult(response).message).toContain('already booked');
    });

    it('should successfully handle a flat Custom Tool Call format for checkAvailability and bookAppointment', async () => {
      // Mock calendar to be available
      (GoogleCalendarService.checkAvailability as jest.Mock).mockResolvedValue(true);
      (GoogleCalendarService.createEvent as jest.Mock).mockResolvedValue('gcal-flat-event-uuid');

      const checkTime = bookableSlot();

      // 1. Test flat checkAvailability
      const checkResponse = await request(app)
        .post(`/api/v1/voice/webhook?tenant_id=${tenantId}&calendar_id=${calendarId}`)
        .set('x-api-key', apiKey)
        .send({
          dateTime: checkTime.toISOString(),
        });

      expect(checkResponse.status).toBe(200);
      expect(checkResponse.body.available).toBe(true);
      expect(checkResponse.body.message).toContain('available');

      // 2. Test flat bookAppointment
      const bookResponse = await request(app)
        .post(`/api/v1/voice/webhook?tenant_id=${tenantId}&calendar_id=${calendarId}`)
        .set('x-api-key', apiKey)
        .send({
          dateTime: checkTime.toISOString(),
          customerName: 'Flat Patient',
          customerPhone: '555-0777',
          customerEmail: 'flat@example.com',
        });

      expect(bookResponse.status).toBe(200);
      expect(bookResponse.body.success).toBe(true);
      expect(bookResponse.body.appointmentId).toBeDefined();

      // Wait for background sync to complete (max 2 seconds)
      let appointment = null;
      for (let i = 0; i < 40; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        appointment = await prisma.appointment.findFirst({
          where: {
            tenantId,
            calendarId,
            appointmentDateTime: checkTime,
          },
        });
        if (appointment?.googleEventId) {
          break;
        }
      }

      expect(appointment).not.toBeNull();
      expect(appointment?.customerName).toBe('Flat Patient');
      expect(appointment?.googleEventId).toBe('gcal-flat-event-uuid');
    });
  });
});

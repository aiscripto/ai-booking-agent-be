import { Router } from 'express';
import { AppointmentController } from '../controllers/appointment.controller';
import { requireAuth, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

// Every appointment and call-log route needs a signed-in staff member.
// The tenant comes from the verified token, never from a header or query.
router.use(requireAuth, requirePermission('dashboard.view'));

// Retrieve appointments
router.get('/', requirePermission('appointments.view'), AppointmentController.listAppointments);

// Create a new appointment
router.post('/', requirePermission('appointments.create'), AppointmentController.createAppointment);

// Cancel an existing appointment
router.delete('/:id', requirePermission('appointments.cancel'), AppointmentController.cancelAppointment);

// Retrieve recent call logs
router.get('/logs', requirePermission('calls.view'), AppointmentController.listCallLogs);

// Retrieve one call log with transcript and payload
router.get('/logs/:id', requirePermission('calls.transcripts'), AppointmentController.getCallLog);

// Generate video call link for an appointment
router.post('/:id/telehealth', requirePermission('appointments.create'), AppointmentController.generateTelehealthLink);

export const appointmentRouter = router;


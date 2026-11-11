import { z } from 'zod';
import { ALL_PERMISSIONS, isPermission } from '../config/permissions';
import { hasOpenDay, weeklyHoursSchema } from '../services/business-hours';
import { isValidTimeZone } from '../services/tenant-schedule.service';

/** Text from a form: trimmed, and an empty box means "nothing" (null). */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const requiredText = (max: number) => z.string().trim().min(1, 'This field is required.').max(max);

const optionalEmail = z
  .string()
  .trim()
  .max(254)
  .nullish()
  .transform((v) => (v ? v.toLowerCase() : null))
  .refine((v) => v === null || z.string().email().safeParse(v).success, { message: 'Enter a valid email address.' });

const optionalId = z
  .string()
  .uuid()
  .nullish()
  .transform((v) => v ?? null);

export const idParamSchema = z.object({ id: z.string().uuid() });

export const businessSchema = z.object({
  name: requiredText(120),
  phone: text(40),
  email: optionalEmail,
  address: text(200),
  city: text(80),
  state: text(80),
  zip: text(20),
  latitude: z.number().min(-90).max(90).nullish().transform((v) => v ?? null),
  longitude: z.number().min(-180).max(180).nullish().transform((v) => v ?? null),
  timeZone: z.string().trim().min(1, 'Choose a time zone.').refine(isValidTimeZone, { message: 'That is not a valid time zone (for example America/New_York).' }),
  businessHours: weeklyHoursSchema.refine(hasOpenDay, { message: 'Open at least one day, or nobody can book.' }),
}).refine((v) => (v.latitude === null) === (v.longitude === null), {
  message: 'Give both latitude and longitude, or neither.',
  path: ['latitude'],
});
export type BusinessInput = z.infer<typeof businessSchema>;

export const gradeSchema = z.object({
  code: requiredText(20).regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore only.'),
  name: text(80),
  isActive: z.boolean().default(true),
});
export type GradeInput = z.infer<typeof gradeSchema>;

export const departmentSchema = z.object({
  name: requiredText(120),
  description: text(500),
  location: text(200),
  contact: text(120),
  email: optionalEmail,
  isActive: z.boolean().default(true),
});
export type DepartmentInput = z.infer<typeof departmentSchema>;

export const employeeSchema = z.object({
  fullName: requiredText(120),
  email: optionalEmail,
  phone: text(40),
  departmentId: optionalId,
  gradeId: optionalId,
  roleId: optionalId,
  managerId: optionalId,
  isActive: z.boolean().default(true),
  // Consultant: takes appointments. `title` is what the voice agent says; `categoryIds` are the services
  // they offer; `workingHours` is their own week (null = they follow the business hours).
  isBookable: z.boolean().default(false),
  title: text(120),
  categoryIds: z.array(z.string().uuid()).max(50).default([]).transform((ids) => [...new Set(ids)]),
  workingHours: weeklyHoursSchema.nullish().transform((v) => v ?? null),
});
export type EmployeeInput = z.infer<typeof employeeSchema>;

export const roleSchema = z.object({
  code: requiredText(40)
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z][A-Z0-9_]{1,39}$/.test(v), {
      message: 'Use capital letters, numbers and underscore, starting with a letter (for example LINE_MANAGER).',
    }),
  name: requiredText(80),
  description: text(300),
  permissions: z
    .array(z.string())
    .max(ALL_PERMISSIONS.length)
    .refine((list) => list.every(isPermission), { message: 'Unknown permission.' })
    .transform((list) => [...new Set(list)]),
  isActive: z.boolean().default(true),
});
export type RoleInput = z.infer<typeof roleSchema>;

const username = z
  .string()
  .trim()
  .min(3, 'The user name must have at least 3 characters.')
  .max(100)
  .regex(/^[A-Za-z0-9._@+-]+$/, 'Use letters, numbers and . _ @ + - only (no spaces).')
  .transform((v) => v.toLowerCase());

const password = z
  .string()
  .min(12, 'The password must have at least 12 characters.')
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, { message: 'The password is too long (72 bytes at most).' });

export const createUserSchema = z.object({
  username,
  password,
  name: text(120),
  roleId: z.string().uuid(),
  employeeId: optionalId,
  isActive: z.boolean().default(true),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

/** Changing a user: the user name never changes; leave the password out to keep it. */
export const updateUserSchema = z.object({
  password: password.optional(),
  name: text(120),
  roleId: z.string().uuid(),
  employeeId: optionalId,
  isActive: z.boolean(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const categorySchema = z.object({
  name: requiredText(80),
  description: text(300),
  isActive: z.boolean().default(true),
});
export type CategoryInput = z.infer<typeof categorySchema>;

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-24.').refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d, { message: 'That date does not exist.' });

export const timeOffSchema = z
  .object({ startDate: calendarDate, endDate: calendarDate, note: text(200) })
  .refine((v) => v.endDate >= v.startDate, { message: 'The last day cannot be before the first day.', path: ['endDate'] });
export type TimeOffInput = z.infer<typeof timeOffSchema>;

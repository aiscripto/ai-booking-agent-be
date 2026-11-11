/**
 * The fixed list of things a user can be allowed to do. A role is a set of these codes.
 * The list lives in code on purpose: every code here is checked by a route. A code that no route
 * checks would be a promise the system cannot keep.
 */
export const PERMISSIONS = [
  { code: 'dashboard.view', label: 'Use the dashboard', description: 'Sign in to the dashboard and see the calendar status and business labels.' },
  { code: 'appointments.view', label: 'See appointments', description: 'List appointments.' },
  { code: 'appointments.create', label: 'Book appointments', description: 'Create appointments and video links.' },
  { code: 'appointments.cancel', label: 'Cancel appointments', description: 'Cancel appointments.' },
  { code: 'calls.view', label: 'See the call list', description: 'List recent calls (no transcripts).' },
  { code: 'calls.transcripts', label: 'Read call transcripts', description: 'Open one call with its transcript and raw data.' },
  { code: 'providers.manage', label: 'Manage providers', description: 'Add or remove bookable providers.' },
  { code: 'settings.business', label: 'Manage business settings', description: 'Business details, branding and the Google Calendar connection.' },
  { code: 'organization.manage', label: 'Manage the organization', description: 'Grades, departments and employees.' },
  { code: 'users.manage', label: 'Manage users and roles', description: 'Roles, permissions and user accounts.' },
] as const;

export type Permission = (typeof PERMISSIONS)[number]['code'];

export const ALL_PERMISSIONS: Permission[] = PERMISSIONS.map((p) => p.code);

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as string[]).includes(value);
}

export type BuiltInRole = 'ADMIN' | 'PROVIDER' | 'FRONT_DESK' | 'PATIENT';

const STAFF_DEFAULT: Permission[] = [
  'dashboard.view',
  'appointments.view',
  'appointments.create',
  'appointments.cancel',
  'calls.view',
  'calls.transcripts',
];

/** What each built-in role may do until the owner changes it. ADMIN always has everything. */
export const BUILT_IN_ROLES: Record<BuiltInRole, { name: string; description: string; permissions: Permission[] }> = {
  ADMIN: { name: 'Admin', description: 'Full access: settings, organization, users and roles.', permissions: ALL_PERMISSIONS },
  FRONT_DESK: { name: 'Front desk', description: 'Books and cancels appointments and reads calls.', permissions: STAFF_DEFAULT },
  PROVIDER: { name: 'Provider', description: 'Sees appointments and calls.', permissions: STAFF_DEFAULT },
  PATIENT: { name: 'Patient', description: 'No dashboard access.', permissions: [] },
};

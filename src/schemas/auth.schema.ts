import { z } from 'zod';

// bcrypt only uses the first 72 bytes of a password, so longer input is refused instead of
// being silently cut.
export const loginSchema = z.object({
  // A username or an email address. (The field keeps the name `email` so older clients still work.)
  email: z.string().trim().min(1).max(254),
  password: z
    .string()
    .min(1)
    .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, { message: 'Password is too long.' }),
});

export type LoginInput = z.infer<typeof loginSchema>;

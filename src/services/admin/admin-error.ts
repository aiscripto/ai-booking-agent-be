import { Prisma } from '@prisma/client';

/** An error the admin panel can show to the user as it is. `statusCode` is read by the error middleware. */
export class AdminError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = 'AdminError';
  }
}

/** True when the database refused a duplicate value (unique constraint). */
export function isDuplicate(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

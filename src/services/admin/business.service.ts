import { prisma } from '../db.service';
import { Prisma } from '@prisma/client';
import { AdminError } from './admin-error';
import { TenantScheduleService } from '../tenant-schedule.service';
import type { BusinessInput } from '../../schemas/admin.schema';

const select = {
  id: true,
  name: true,
  phone: true,
  email: true,
  address: true,
  city: true,
  state: true,
  zip: true,
  latitude: true,
  longitude: true,
} as const;

export class BusinessService {
  public static async get(tenantId: string) {
    const tenant = await prisma.tenant.findFirst({ where: { id: tenantId }, select: { ...select, businessHours: true, timeZone: true } });
    if (!tenant) throw new AdminError('Business not found.', 404);
    // What really applies now (the stored values, or the server settings when none are stored).
    const { timeZone, weekly } = await TenantScheduleService.get(tenantId);
    const { businessHours, timeZone: storedZone, ...rest } = tenant;
    return { ...rest, timeZone, businessHours: weekly, hoursAreDefaults: businessHours === null || storedZone === null };
  }

  public static async update(tenantId: string, input: BusinessInput) {
    const result = await prisma.tenant.updateMany({
      where: { id: tenantId },
      data: { ...input, businessHours: input.businessHours as unknown as Prisma.InputJsonValue },
    });
    if (result.count !== 1) throw new AdminError('Business not found.', 404);
    // Free times already worked out under the old hours must not be served any more.
    TenantScheduleService.invalidate(tenantId);
    return BusinessService.get(tenantId);
  }
}

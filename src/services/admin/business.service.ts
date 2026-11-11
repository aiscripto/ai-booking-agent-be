import { prisma } from '../db.service';
import { AdminError } from './admin-error';
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
    const tenant = await prisma.tenant.findFirst({ where: { id: tenantId }, select });
    if (!tenant) throw new AdminError('Business not found.', 404);
    return tenant;
  }

  public static async update(tenantId: string, input: BusinessInput) {
    const result = await prisma.tenant.updateMany({ where: { id: tenantId }, data: input });
    if (result.count !== 1) throw new AdminError('Business not found.', 404);
    return BusinessService.get(tenantId);
  }
}

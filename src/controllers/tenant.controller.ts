import { Request, Response, NextFunction } from 'express';
import { prisma } from '../services/db.service';
import { getVocabulary } from '../config/industry-vocabulary';
import { z } from 'zod';
import { IndustryType } from '@prisma/client';
import { slotCacheService } from '../services/slot-cache.service';
import { TenantScheduleService } from '../services/tenant-schedule.service';
import { summarize } from '../services/business-hours';
import { ConsultantService } from '../services/consultants/consultant.service';


export class TenantController {
  /**
   * When appointments can be offered. `weekly` is the full answer (seven lists, Sunday first); `start`, `end`
   * and `days` are the short form (earliest opening, latest closing, open days) for the calendar grid.
   */
  private static async schedule(tenantId: string) {
    const { timeZone, weekly } = await TenantScheduleService.get(tenantId);
    return { timeZone, businessHours: { ...summarize(weekly), weekly } };
  }

  /**
   * The caller's tenant from the verified login token. Sends 401 and returns null if missing.
   * The request's own body, query and headers are never used to choose a tenant.
   */
  private static authTenant(req: Request, res: Response): string | null {
    const tenantId = req.auth?.tenantId;
    if (!tenantId) {
      res.status(401).json({ status: 'error', message: 'Authentication required.' });
      return null;
    }
    return tenantId;
  }

  /**
   * GET /api/v1/tenant/vocabulary (the signed-in user's own tenant)
   */
  public static async getVocabulary(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tenantId = TenantController.authTenant(req, res);
      if (!tenantId) return;

      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
      const vocabulary = getVocabulary(tenant?.industry || 'GENERAL');
      const when = await TenantController.schedule(tenantId);

      res.status(200).json({
        status: 'success',
        data: {
          tenantId,
          tenantName: tenant?.name ?? null,
          industry: tenant?.industry ?? null,
          vocabulary,
          // The time zone every time should be shown in (times are stored in UTC).
          timeZone: when.timeZone,
          businessHours: when.businessHours,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/tenant/consultants: who can be booked and for what (active only). Empty lists mean the
   * business books one calendar, so the booking screens show no consultant choice.
   */
  public static async getConsultants(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tenantId = TenantController.authTenant(req, res);
      if (!tenantId) return;
      const [consultants, categories] = await Promise.all([ConsultantService.list(tenantId), ConsultantService.categories(tenantId)]);
      res.status(200).json({
        status: 'success',
        data: {
          categories,
          consultants: consultants.map((c) => ({ id: c.id, fullName: c.fullName, title: c.title, categoryIds: c.categories.map((x) => x.id) })),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/tenant/branding (the signed-in user's own tenant)
   */
  public static async getBranding(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tenantId = TenantController.authTenant(req, res);
      if (!tenantId) return;

      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        include: {
          resources: {
            where: { isActive: true },
            include: { department: true },
          },

          serviceTypes: true,
          departments: true,
        },
      });

      if (!tenant) {
        res.status(404).json({ status: 'error', message: 'Tenant not found.' });
        return;
      }
      const when = await TenantController.schedule(tenantId);

      res.status(200).json({
        status: 'success',
        data: {
          tenantId: tenant.id,
          name: tenant.name,
          industry: tenant.industry,
          branding: tenant.branding,
          resources: tenant.resources,
          serviceTypes: tenant.serviceTypes,
          departments: tenant.departments,
          timeZone: when.timeZone,
          businessHours: when.businessHours,
        },
      });

    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/v1/tenant/branding
   */
  public static async updateBranding(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tenantId = TenantController.authTenant(req, res);
      if (!tenantId) return;
      const { industry, branding } = req.body;

      const parsedIndustry = industry === undefined || industry === null || industry === ''
        ? { success: true as const, data: undefined }
        : z.nativeEnum(IndustryType).safeParse(industry);
      if (!parsedIndustry.success) {
        res.status(400).json({ status: 'error', message: 'Invalid industry.' });
        return;
      }

      // Explicit field list: never return calApiKey or other secrets.
      const updated = await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          industry: parsedIndustry.data,
          branding: branding || undefined,
        },
        select: { id: true, name: true, industry: true, branding: true },
      });

      res.status(200).json({
        status: 'success',
        message: 'Tenant branding and preset updated successfully.',
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/tenant/resources (Onboard New Doctor / Consultant)
   */
  public static async onboardResource(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tenantId = TenantController.authTenant(req, res);
      if (!tenantId) return;
      const { name, email, title } = req.body;

      if (!name || !email) {
        res.status(400).json({ status: 'error', message: 'name and email are required fields.' });
        return;
      }

      const resource = await prisma.resource.create({
        data: {
          tenantId,
          name,
          email,
          title: title || 'Specialist Consultant',
        },
      });

      // Purge slot cache for tenant so Voice AI immediately sees new doctor
      slotCacheService.invalidate();


      res.status(201).json({
        status: 'success',
        message: 'Doctor / Consultant onboarded successfully.',
        data: resource,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/v1/tenant/resources/:id (Offboard Doctor / Consultant)
   */
  public static async offboardResource(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({ status: 'error', message: 'Resource ID path parameter is required.' });
        return;
      }

      // Pro-level soft deletion: Mark doctor as inactive to preserve HIPAA historical records
      const tenantId = TenantController.authTenant(req, res);
      if (!tenantId) return;

      // Same-statement tenant filter: an admin can only offboard their own tenant's resources.
      const result = await prisma.resource.updateMany({
        where: { id, tenantId },
        data: { isActive: false },
      });
      if (result.count === 0) {
        res.status(404).json({ status: 'error', message: 'Resource not found.' });
        return;
      }


      // Purge slot cache so Voice AI instantly stops offering slots for offboarded doctor
      slotCacheService.invalidate();


      res.status(200).json({
        status: 'success',
        message: 'Doctor / Consultant offboarded successfully.',
      });
    } catch (error) {
      next(error);
    }
  }
}


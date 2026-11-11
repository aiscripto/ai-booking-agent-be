import { prisma } from './db.service';
import { ConsultantService } from './consultants/consultant.service';

export interface DynamicPromptConfig {
  tenantName: string;
  industry: string;
  resources: Array<{ name: string; title?: string | null }>;
  serviceTypes: Array<{ name: string; durationMinutes: number; price?: number | null }>;
  intakeFields?: string[];
  /** True when the business has consultants: bookings are with a named person or "anyone". */
  consultantMode?: boolean;
}

export class VoicePromptBuilder {
  /**
   * Industry-specific tone and instruction templates
   */
  private static INDUSTRY_INSTRUCTIONS: Record<string, string> = {
    HEALTHCARE: 'You speak warmly, professionally, and with empathy as a healthcare receptionist. You assist patients in booking medical checkups and consultations with doctors.',
    SALON_WELLNESS: 'You speak in a friendly, enthusiastic, and welcoming tone. You assist clients in booking salon treatments, hair styling, and spa sessions.',
    LEGAL_CONSULTING: 'You speak with formal professionalism and high discretion. You assist clients in scheduling legal strategy sessions and advisor consultations.',
    REAL_ESTATE: 'You speak with professional enthusiasm. You assist home buyers and prospective clients in scheduling property viewings and valuation tours.',
    AUTOMOTIVE: 'You speak clearly and directly as a service desk receptionist. You assist car owners in scheduling vehicle repair and maintenance bays.',
    FITNESS: 'You speak energetically and encouragingly. You assist gym members and clients in booking personal training sessions.',
    GENERAL: 'You speak with professional courtesy. You assist customers in booking appointments and scheduling services.',
  };

  /**
   * Build dynamic system prompt string from tenant configuration
   */
  public static buildSystemPrompt(config: DynamicPromptConfig): string {
    const { tenantName, industry, resources, serviceTypes, intakeFields = [], consultantMode = false } = config;

    const baseInstruction = this.INDUSTRY_INSTRUCTIONS[industry] || this.INDUSTRY_INSTRUCTIONS.GENERAL;

    const resourceList = resources.length > 0
      ? resources.map((r) => `- ${r.name}${r.title ? ` (${r.title})` : ''}`).join('\n')
      : '- General Service Provider';

    const serviceList = serviceTypes.length > 0
      ? serviceTypes.map((s) => `- ${s.name} (${s.durationMinutes} mins${s.price ? `, $${s.price}` : ''})`).join('\n')
      : '- Standard Appointment (30 mins)';

    const intakeList = intakeFields.length > 0
      ? `Required Information to Collect from Caller:\n${intakeFields.map((f) => `- ${f}`).join('\n')}`
      : '- Caller Name and Contact Phone Number';

    return `
You are the 24/7 AI Phone Receptionist for ${tenantName}.
${baseInstruction}

Team Members / Staff Available:
${resourceList}

Services Offered:
${serviceList}

${intakeList}

Instructions & Conversation Flow:
1. Greet the caller warmly as the AI Receptionist for ${tenantName}.
2. Ask how you can assist them today and identify their desired service.
3. Call the 'checkAvailability' function to query real-time calendar slots.
4. Offer the available times clearly and confirm their preferred slot.
5. Collect required caller information.
6. Call the 'bookAppointment' function to lock in their booking.
7. Confirm the booked appointment time before ending the call gracefully.
${consultantMode ? `
Consultants:
- This business books appointments with a named consultant. Ask which service the caller needs and whether they want a particular person or anyone.
- Pass 'category' (the service) and 'consultant' (the person's name) to 'checkAvailability' and 'bookAppointment'. Leave 'consultant' out when the caller says anyone.
- Call 'listConsultants' to learn the real names and services. Never invent a name or a service.
- Tell the caller who the appointment is with after booking.` : ''}
`.trim();
  }

  /**
   * Load tenant settings from DB and compile prompt
   */
  public static async buildPromptForTenant(tenantId: string): Promise<string> {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        resources: true,
        serviceTypes: true,
      },
    });
    // With consultants, the team list is the consultants and the services are the service categories.
    const consultantMode = tenant ? await ConsultantService.isActive(tenantId) : false;
    const consultants = consultantMode ? await ConsultantService.list(tenantId) : [];
    const categories = consultantMode ? await ConsultantService.categories(tenantId) : [];

    if (!tenant) {
      return this.buildSystemPrompt({
        tenantName: 'Default Booking Agency',
        industry: 'GENERAL',
        resources: [{ name: 'Staff Receptionist' }],
        serviceTypes: [{ name: 'Standard Consultation', durationMinutes: 30 }],
      });
    }

    // Extract dynamic intake fields from service type JSON schemas
    const intakeFieldsSet = new Set<string>();
    tenant.serviceTypes.forEach((st) => {
      const schema = st.intakeSchema as any;
      if (schema?.properties) {
        Object.keys(schema.properties).forEach((k) => intakeFieldsSet.add(schema.properties[k]?.title || k));
      }
    });

    return this.buildSystemPrompt({
      tenantName: tenant.name,
      industry: tenant.industry,
      resources: consultantMode
        ? consultants.map((c) => ({ name: c.fullName, title: c.title }))
        : tenant.resources.map((r) => ({ name: r.name, title: r.title })),
      serviceTypes: consultantMode
        ? categories.map((c) => ({ name: c.name, durationMinutes: 30 }))
        : tenant.serviceTypes.map((s) => ({
            name: s.name,
            durationMinutes: s.durationMinutes,
            price: s.price ? Number(s.price) : null,
          })),
      intakeFields: Array.from(intakeFieldsSet),
      consultantMode,
    });
  }
}

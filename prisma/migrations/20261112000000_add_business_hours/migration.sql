-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "business_hours" JSONB,
ADD COLUMN     "time_zone" TEXT;

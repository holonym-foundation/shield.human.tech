-- AlterTable
ALTER TABLE "bridge_activities" ADD COLUMN     "clientIp" TEXT,
ADD COLUMN     "epoch" INTEGER;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "lastLoginIp" TEXT;

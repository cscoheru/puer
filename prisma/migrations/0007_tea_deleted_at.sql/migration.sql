-- P2-R21 品牌管理删除箱：茶品软删除
ALTER TABLE "teas" ADD COLUMN "deletedAt" TIMESTAMP(3);
CREATE INDEX "teas_deletedAt_idx" ON "teas"("deletedAt");

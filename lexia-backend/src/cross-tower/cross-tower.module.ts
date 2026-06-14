import { Module, OnModuleInit } from "@nestjs/common";
import { CrossTowerController } from "./cross-tower.controller";
import { CrossTowerService } from "./cross-tower.service";
import { ensureCrossTowerSchema } from "./db";

@Module({
  controllers: [CrossTowerController],
  providers: [CrossTowerService],
})
export class CrossTowerModule implements OnModuleInit {
  // Create the ct_* tables (and seed on first boot) as soon as the app starts,
  // so the schema exists in Postgres even before the first API call.
  async onModuleInit() {
    await ensureCrossTowerSchema();
  }
}

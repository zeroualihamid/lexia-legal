import { Module } from '@nestjs/common';
import { DriveConnectorsController } from './drive-connectors.controller';
import { DriveConnectorsService } from './drive-connectors.service';
import { StorageModule } from '../../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [DriveConnectorsController],
  providers: [DriveConnectorsService],
  exports: [DriveConnectorsService],
})
export class DriveConnectorsModule {}

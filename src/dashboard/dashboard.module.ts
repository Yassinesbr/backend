import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { PrismaService } from '../prisma.service';

@Module({
  providers: [DashboardService, PrismaService],
  controllers: [DashboardController],
})
export class DashboardModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TenantsController } from './controllers/tenants.controller';
import { SourcesController } from './controllers/sources.controller';
import { EventsController } from './controllers/events.controller';
import { VerificationController } from './controllers/verification.controller';
import { ArchiveController } from './controllers/archive.controller';
import { ReconciliationController } from './controllers/reconciliation.controller';
import { HealthController } from './controllers/health.controller';
import { SigilService } from './services/sigil.service';
import { AuditModule } from './audit/audit.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    AuditModule,
  ],
  controllers: [
    HealthController,
    TenantsController,
    SourcesController,
    EventsController,
    VerificationController,
    ArchiveController,
    ReconciliationController,
  ],
  providers: [SigilService],
})
export class CollectorModule {}

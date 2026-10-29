import { Controller, Get, Query } from '@nestjs/common';
import { SigilService } from '../services/sigil.service';

@Controller('api/v1/reconciliation')
export class ReconciliationController {
  constructor(private readonly sigilService: SigilService) {}

  @Get('findings')
  find(@Query() query: any) {
    return this.sigilService.listFindings();
  }
}

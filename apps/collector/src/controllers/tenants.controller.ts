import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { SigilService } from '../services/sigil.service';

@Controller('api/v1/tenants')
export class TenantsController {
  constructor(private readonly sigilService: SigilService) {}

  @Post()
  create(@Body() dto: any) {
    return this.sigilService.createTenant(dto);
  }

  @Get(':id')
  get(@Param('id') string id: string) {
    return this.sigilService.getTenant(id);
  }
}

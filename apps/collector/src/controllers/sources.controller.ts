import { Body, Controller, Param, Post } from '@nestjs/common';
import { SigilService } from '../services/sigil.service';

@Controller('api/v1/sources')
export class SourcesController {
  constructor(private readonly sigilService: SigilService) {}

  @Post()
  create(@Body() dto: any) {
    return this.sigilService.createSource(dto);
  }

  @Post(':id/keys')
  createKey(@Param('id') id: string, @Body() dto: any) {
    return this.sigilService.createKey(id, dto);
  }
}

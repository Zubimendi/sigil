import { Body, Controller, Get, Query, Post } from '@nestjs/common';
import { SigilService } from '../services/sigil.service';

@Controller('api/v1/events')
export class EventsController {
  constructor(private readonly sigilService: SigilService) {}

  @Post('batches')
  ingestBatch(@Body() dto: any) {
    return this.sigilService.ingestBatch(dto);
  }

  @Get()
  list(@Query() query: any) {
    return this.sigilService.listEvents(query);
  }
}

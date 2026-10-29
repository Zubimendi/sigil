import { Controller, Get } from '@nestjs/common';
import { SigilService } from '../services/sigil.service';

@Controller()
export class HealthController {
  constructor(private readonly sigilService: SigilService) {}

  @Get('health')
  health() {
    return this.sigilService.getHealth();
  }
}

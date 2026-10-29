import { Body, Controller, Post } from '@nestjs/common';
import { SigilService } from '../services/sigil.service';

@Controller('api/v1/verify')
export class VerificationController {
  constructor(private readonly sigilService: SigilService) {}

  @Post('inclusion')
  verifyInclusion(@Body() dto: any) {
    return this.sigilService.verifyInclusion(dto);
  }

  @Post('archive')
  verifyArchive(@Body() dto: any) {
    return this.sigilService.verifyArchive(dto);
  }
}

import { Body, Controller, Post } from '@nestjs/common';
import { SigilService } from '../services/sigil.service';

@Controller('api/v1')
export class ArchiveController {
  constructor(private readonly sigilService: SigilService) {}

  @Post('archive/manifests')
  createArchive(@Body() dto: any) {
    return this.sigilService.registerArchive(dto);
  }

  @Post('retention/approvals')
  approveRetention(@Body() dto: any) {
    return this.sigilService.approveRetention(dto);
  }
}

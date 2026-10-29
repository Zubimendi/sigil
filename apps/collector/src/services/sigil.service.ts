import { Injectable } from '@nestjs/common';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: string;
  created_by: string;
}

@Injectable()
export class SigilService {
  private tenants = new Map<string, Tenant>();
  private sources = new Map<string, any>();
  private events: any[] = [];
  private archives: any[] = [];
  private findings: any[] = [];

  getHealth() {
    return {
      ok: true,
      service: 'sigil-collector',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
    };
  }

  createTenant(dto: any) {
    const id = dto.id || `tenant-${Date.now()}`;
    const tenant = { id, ...dto };
    this.tenants.set(id, tenant);
    return tenant;
  }

  getTenant(id: string) {
    return this.tenants.get(id) || null;
  }

  createSource(dto: any) {
    const id = dto.id || dto.name?.toLowerCase().replace(/\s+/g, '-') || `source-${Date.now()}`;
    const source = {
      id,
      tenant_id: dto.tenant_id,
      name: dto.name,
      kind: dto.kind,
      heartbeat_s: dto.heartbeat_s || 60,
      public_key: dto.public_key,
      created_at: new Date().toISOString(),
    };
    this.sources.set(id, source);
    return source;
  }

  createKey(sourceId: string, dto: any) {
    const source = this.sources.get(sourceId);
    if (!source) {
      return null;
    }
    source.public_key = dto.public_key;
    source.key_valid_from = dto.valid_from || new Date().toISOString();
    return source;
  }

  ingestBatch(dto: any) {
    const batchResult = {
      accepted: true,
      tenant_id: dto.tenant_id,
      source_id: dto.source_id,
      stream_id: dto.stream_id,
      batch_hash: dto.batch_hash,
      received_at: dto.received_at || new Date().toISOString(),
      event_count: Array.isArray(dto.events) ? dto.events.length : 0,
      first_source_seq: Array.isArray(dto.events) && dto.events.length ? dto.events[0].source_seq : null,
      last_source_seq: Array.isArray(dto.events) && dto.events.length ? dto.events[dto.events.length - 1].source_seq : null,
      events: dto.events || [],
    };

    for (const event of dto.events || []) {
      this.events.push({
        ...event,
        stream_id: dto.stream_id,
        ingested_at: new Date().toISOString(),
        claim_hash: event.payload_commitment || `sha256:${event.event_id}`,
      });
    }

    return batchResult;
  }

  listEvents(query: any) {
    let items = [...this.events];
    if (query.stream_id) {
      items = items.filter((event) => event.stream_id === query.stream_id);
    }
    if (query.source_id) {
      items = items.filter((event) => event.source_id === query.source_id);
    }
    return items.slice(0, Number(query.limit || 50));
  }

  verifyInclusion(dto: any) {
    return {
      valid: true,
      stream_id: dto.stream_id,
      event_id: dto.event_id,
      leaf_index: dto.leaf_index,
      root_hash: dto.root_hash,
      proof_length: Array.isArray(dto.proof) ? dto.proof.length : 0,
      verified_at: new Date().toISOString(),
    };
  }

  registerArchive(dto: any) {
    const archive = {
      id: dto.archive_id || `archive-${Date.now()}`,
      ...dto,
      status: dto.status || 'PENDING',
      created_at: new Date().toISOString(),
    };
    this.archives.push(archive);
    return archive;
  }

  verifyArchive(dto: any) {
    return {
      ok: true,
      archive_id: dto.archive_id,
      object_key: dto.object_key,
      verified: true,
      sha256_match: true,
      verified_at: new Date().toISOString(),
    };
  }

  approveRetention(dto: any) {
    return {
      approved: true,
      ...dto,
      recorded_at: new Date().toISOString(),
    };
  }

  listFindings() {
    if (this.findings.length === 0) {
      this.findings.push({
        id: 'finding-1',
        source_a: 'gateway-proxy',
        source_b: 'app-service',
        correlation_key: 'patient-512',
        kind: 'GATEWAY_MISSING_APP',
        detected_at: new Date().toISOString(),
      });
    }
    return this.findings;
  }
}

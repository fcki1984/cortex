import type { FastifyInstance } from 'fastify';
import type { CortexApp } from '../app.js';
import {
  buildCanonicalExportBundle,
  buildMemoryMarkdown,
  confirmImport,
  previewImport,
  type ExportFormat,
  type ExportScope,
  type ImportFormat,
} from '../v2/import-export.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('import-export');

function parseImportFormat(raw: unknown): ImportFormat {
  if (raw === 'json' || raw === 'memory_md' || raw === 'text') return raw;
  return 'json';
}

function parseExportFormat(raw: unknown): ExportFormat {
  if (raw === 'json' || raw === 'memory_md') return raw;
  return 'json';
}

function parseExportScope(raw: unknown): ExportScope {
  if (raw === 'all_agents' || raw === 'current_agent') return raw;
  return 'current_agent';
}

export function registerImportExportRoutes(app: FastifyInstance, cortex: CortexApp): void {
  app.post('/api/v2/import/preview', async (req, reply) => {
    const body = req.body as {
      agent_id?: string;
      format?: ImportFormat;
      content?: string;
      filename?: string;
    };

    if (!body.agent_id) {
      reply.code(400);
      return { error: 'agent_id is required' };
    }
    if (!body.content?.trim()) {
      reply.code(400);
      return { error: 'content is required' };
    }

    try {
      return previewImport({
        agent_id: body.agent_id,
        format: parseImportFormat(body.format),
        content: body.content,
      });
    } catch (error: any) {
      log.warn({ error: error.message }, 'Import preview failed');
      reply.code(400);
      return { error: error.message };
    }
  });

  app.post('/api/v2/import/confirm', async (req, reply) => {
    const body = req.body as {
      agent_id?: string;
      record_candidates?: any[];
      relation_candidates?: any[];
    };

    if (!body.agent_id) {
      reply.code(400);
      return { error: 'agent_id is required' };
    }
    if (!Array.isArray(body.record_candidates)) {
      reply.code(400);
      return { error: 'record_candidates must be an array' };
    }

    try {
      const result = await confirmImport(cortex.recordsV2, cortex.relationsV2, {
        agent_id: body.agent_id,
        record_candidates: body.record_candidates as any,
        relation_candidates: Array.isArray(body.relation_candidates) ? body.relation_candidates as any : [],
      });
      reply.code(201);
      return result;
    } catch (error: any) {
      log.error({ error: error.message }, 'Import confirm failed');
      reply.code(500);
      return { error: error.message };
    }
  });

  app.get('/api/v2/export', async (req, reply) => {
    const query = req.query as {
      scope?: ExportScope;
      agent_id?: string;
      format?: ExportFormat;
    };

    try {
      const bundle = buildCanonicalExportBundle(cortex.recordsV2, cortex.relationsV2, {
        scope: parseExportScope(query.scope),
        agent_id: query.agent_id,
      });

      if (parseExportFormat(query.format) === 'memory_md') {
        return {
          format: 'memory_md',
          exported_at: bundle.exported_at,
          scope: bundle.scope,
          content: buildMemoryMarkdown(bundle),
        };
      }

      return bundle;
    } catch (error: any) {
      log.error({ error: error.message }, 'Export failed');
      reply.code(500);
      return { error: error.message };
    }
  });
}

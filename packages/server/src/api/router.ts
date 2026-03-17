import type { FastifyInstance } from 'fastify';
import type { CortexApp } from '../app.js';
import { registerRecallRoutes } from './recall.js';
import { registerIngestRoutes } from './ingest.js';
import { registerFlushRoutes } from './flush.js';
import { registerSearchRoutes } from './search.js';
import { registerMemoriesRoutes } from './memories.js';
import { registerRelationsRoutes } from './relations.js';
import { registerLifecycleRoutes } from './lifecycle.js';
import { registerSystemRoutes } from './system.js';
import { registerMCPRoutes } from './mcp.js';
import { registerImportExportRoutes } from './import-export.js';
import { registerAgentRoutes } from './agents.js';
import { registerExtractionLogRoutes } from './extraction-logs.js';
import { registerFeedbackRoutes } from './feedback.js';
import { registerV2RecordRoutes } from './records-v2.js';
import { registerV2IngestRoutes } from './ingest-v2.js';
import { registerV2RecallRoutes } from './recall-v2.js';
import { registerV2StatsRoutes } from './stats-v2.js';

export function registerAllRoutes(app: FastifyInstance, cortex: CortexApp): void {
  registerSystemRoutes(app, cortex);
  registerMCPRoutes(app, cortex);
  registerImportExportRoutes(app, cortex);
  registerAgentRoutes(app);
  registerExtractionLogRoutes(app);
  registerV2RecordRoutes(app, cortex);
  registerV2IngestRoutes(app, cortex);
  registerV2RecallRoutes(app, cortex);
  registerV2StatsRoutes(app, cortex);

  if (cortex.config.runtime.legacyMode) {
    registerRecallRoutes(app, cortex);
    registerIngestRoutes(app, cortex);
    registerFlushRoutes(app, cortex);
    registerSearchRoutes(app, cortex);
    registerMemoriesRoutes(app, cortex);
    registerRelationsRoutes(app);
    registerLifecycleRoutes(app, cortex);
    registerFeedbackRoutes(app, cortex);
  }
}

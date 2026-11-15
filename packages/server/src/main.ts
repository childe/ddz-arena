import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildApp } from './app.ts';

const root = resolve(fileURLToPath(import.meta.url), '../../../..');
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

const { app } = await buildApp({
  dbPath: process.env.DDZ_DB ?? resolve(root, 'data/ddz.db'),
  inviteCode: process.env.DDZ_INVITE_CODE,
  webDir: process.env.DDZ_WEB_DIR ?? resolve(root, 'packages/web/dist'),
  docsPath: resolve(root, 'docs/api.md'),
  rateLimit: process.env.DDZ_RATE_LIMIT ? Number(process.env.DDZ_RATE_LIMIT) : undefined,
  logger: process.env.DDZ_LOG !== '0',
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.close().then(() => process.exit(0));
  });
}

await app.listen({ port, host });

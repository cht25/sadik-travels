import { validateConfig, config } from './config.js';
import { buildApp } from './app.js';
import { bootstrapSuperAdmin } from './admin-bootstrap.js';
import { MessagingProvider } from './providers.js';
import { CampaignWorker } from './campaign-worker.js';

validateConfig();
const { app, store } = buildApp();
try {
  const created = await bootstrapSuperAdmin(store);
  if (created) console.log('Super admin bootstrap completed from deployment secrets');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Super admin bootstrap failed');
  store.close();
  process.exit(1);
}
const campaignWorker = new CampaignWorker(store, new MessagingProvider(store));
campaignWorker.start();

const server = app.listen(config.port, config.host, () => console.log(`Sadik Travels listening on http://${config.host}:${config.port}`));

const shutdown = async (signal: string) => {
  console.log(`${signal} received; shutting down gracefully`);
  campaignWorker.stop();
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

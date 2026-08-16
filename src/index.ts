import { validateConfig, config } from './config.js';
import { buildApp } from './app.js';

validateConfig();
const { app, connection } = buildApp();
if (connection) {
  try { await connection; console.log('MongoDB connection established'); }
  catch (error) { console.error('MongoDB connection failed', error); process.exit(1); }
}
const server = app.listen(config.port, config.host, () => {
  console.log(`Sadik Travels backend listening on http://${config.host}:${config.port} (${config.nodeEnv}, data=${config.dataMode}, provider=${config.providerMode}, payments=live)`);
});

const shutdown = async (signal: string) => {
  console.log(`${signal} received; shutting down gracefully`);
  server.close(async () => { if (config.dataMode === 'mongodb') { const mongoose = await import('mongoose'); await mongoose.default.disconnect(); } process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

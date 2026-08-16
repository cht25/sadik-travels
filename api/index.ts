import { validateConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';

validateConfig();
const built = buildApp();
const ready = built.connection ?? Promise.resolve();

export default async function handler(req: any, res: any) {
  await ready;
  return built.app(req, res);
}

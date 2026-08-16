import { Redis as RedisClient } from 'ioredis';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';

const memory = new Map<string, { count: number; resetAt: number }>();
let redis: RedisClient | undefined;
if (config.redisUrl) {
  redis = new RedisClient(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  redis.on('error', () => undefined);
}

export function rateLimit(name: string, limit: number, windowSeconds: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = `rl:${name}:${req.ip}`;
    try {
      let count: number;
      if (redis) {
        if (redis.status === 'wait') await redis.connect();
        count = Number(await redis.incr(key));
        if (count === 1) await redis.expire(key, windowSeconds);
      } else {
        const current = memory.get(key) ?? { count: 0, resetAt: Date.now() + windowSeconds * 1000 };
        if (current.resetAt <= Date.now()) { current.count = 0; current.resetAt = Date.now() + windowSeconds * 1000; }
        current.count += 1; memory.set(key, current); count = current.count;
      }
      res.setHeader('X-RateLimit-Limit', limit);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - count));
      if (count > limit) { res.setHeader('Retry-After', String(windowSeconds)); res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } }); return; }
      next();
    } catch {
      if (config.isProduction) { res.status(503).json({ error: { code: 'RATE_LIMIT_UNAVAILABLE', message: 'Rate limiting service is unavailable' } }); return; }
      next();
    }
  };
}

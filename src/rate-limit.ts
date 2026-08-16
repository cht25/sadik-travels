import type { Request, Response, NextFunction } from 'express';

const counters = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(name: string, limit: number, windowSeconds: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${name}:${req.ip}`;
    const current = counters.get(key) ?? { count: 0, resetAt: Date.now() + windowSeconds * 1000 };
    if (current.resetAt <= Date.now()) { current.count = 0; current.resetAt = Date.now() + windowSeconds * 1000; }
    current.count += 1; counters.set(key, current);
    res.setHeader('X-RateLimit-Limit', limit); res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - current.count));
    if (current.count > limit) { res.setHeader('Retry-After', String(windowSeconds)); res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' } }); return; }
    next();
  };
}

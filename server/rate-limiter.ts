import { Request, Response, NextFunction } from "express";

interface RateLimitRecord {
  timestamps: number[];
}

export interface RateLimitOptions {
  windowMs: number; // Time window in milliseconds
  max: number;      // Max allowed requests per window
  message?: string; // Error message
  keyGenerator?: (req: Request) => string;
  skip?: (req: Request) => boolean;
}

/**
 * In-memory sliding-window rate limiter.
 * Zero external dependencies, auto-prunes stale IP buckets every 5 minutes.
 */
export class MemoryRateLimiter {
  private store = new Map<string, RateLimitRecord>();
  private windowMs: number;
  private max: number;
  private message: string;
  private keyGenerator: (req: Request) => string;
  private skip?: (req: Request) => boolean;
  private cleanupInterval: NodeJS.Timeout;

  constructor(options: RateLimitOptions) {
    this.windowMs = options.windowMs;
    this.max = options.max;
    this.message = options.message || "Too many requests, please try again later.";
    this.keyGenerator = options.keyGenerator || ((req: Request) => {
      const forwarded = req.headers["x-forwarded-for"];
      if (typeof forwarded === "string") {
        return forwarded.split(",")[0].trim();
      }
      return req.ip || req.socket.remoteAddress || "unknown";
    });
    this.skip = options.skip;

    // Prune stale records every 5 minutes to prevent memory leak
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, record] of this.store.entries()) {
        record.timestamps = record.timestamps.filter(t => now - t < this.windowMs);
        if (record.timestamps.length === 0) {
          this.store.delete(key);
        }
      }
    }, 5 * 60 * 1000);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  public middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (this.skip && this.skip(req)) {
        return next();
      }

      const key = this.keyGenerator(req);
      const now = Date.now();
      let record = this.store.get(key);

      if (!record) {
        record = { timestamps: [] };
        this.store.set(key, record);
      }

      // Filter timestamps within current window
      record.timestamps = record.timestamps.filter(t => now - t < this.windowMs);

      const count = record.timestamps.length;
      const remaining = Math.max(0, this.max - count);
      const resetTime = Math.ceil((this.windowMs - (count > 0 ? (now - record.timestamps[0]) : 0)) / 1000);

      // Set standard rate limit headers
      res.setHeader("X-RateLimit-Limit", this.max);
      res.setHeader("X-RateLimit-Remaining", remaining);
      res.setHeader("X-RateLimit-Reset", resetTime);

      if (count >= this.max) {
        res.setHeader("Retry-After", resetTime);
        return res.status(429).json({
          ok: false,
          error: this.message,
          retryAfterSeconds: resetTime
        });
      }

      record.timestamps.push(now);
      return next();
    };
  }
}

// Pre-configured rate limiters
// 1. Auth limiter: 20 login attempts per 15 minutes
export const authRateLimiter = new MemoryRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Too many login attempts. Please wait 15 minutes before trying again."
}).middleware();

// 2. AI / TTS high-cost limiter: 80 requests per minute per IP
export const aiRateLimiter = new MemoryRateLimiter({
  windowMs: 60 * 1000,
  max: 80,
  message: "AI/Voice rate limit exceeded. Please wait a moment before sending more requests."
}).middleware();

// 3. Email dispatch limiter: 30 emails per 5 minutes
export const emailRateLimiter = new MemoryRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 30,
  message: "Email dispatch limit reached. Please wait a few minutes before sending more emails."
}).middleware();

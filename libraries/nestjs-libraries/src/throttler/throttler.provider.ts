import { ThrottlerGuard } from '@nestjs/throttler';
import { ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';

/**
 * The visitor's address. Behind Cloudflare, CF-Connecting-IP is set by
 * Cloudflare and can't be forged by the visitor; the first X-Forwarded-For
 * value can (proxies append to whatever the client sent), so it's only a
 * fallback for setups without Cloudflare.
 */
export const realClientIp = (req: Record<string, any>): string =>
  String(req.headers?.['cf-connecting-ip'] || '').trim() ||
  String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.ip ||
  'unknown';

const isPublicComment = (method: string, url: string) =>
  method === 'POST' && /^\/public\/posts\/[^/]+\/comments/.test(url);

@Injectable()
export class ThrottlerBehindProxyGuard extends ThrottlerGuard {
  public override async canActivate(
    context: ExecutionContext
  ): Promise<boolean> {
    const { url, method } = context.switchToHttp().getRequest<Request>();
    if (
      (method === 'POST' && url.includes('/public/v1/posts')) ||
      isPublicComment(method, url)
    ) {
      return super.canActivate(context);
    }

    return true;
  }

  protected override async getTracker(
    req: Record<string, any>
  ): Promise<string> {
    if (!req.org) {
      return 'ip_' + realClientIp(req);
    }

    return (
      req.org.id + '_' + (req.url.indexOf('/posts') > -1 ? 'posts' : 'other')
    );
  }
}

// route-level guard for public endpoints, keyed by the client address the
// proxy forwards rather than the org the global guard expects
@Injectable()
export class ThrottlerRealIpGuard extends ThrottlerGuard {
  protected override async getTracker(
    req: Record<string, any>
  ): Promise<string> {
    return realClientIp(req);
  }
}

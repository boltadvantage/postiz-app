// Bolt Advantage: Facebook Page webhooks. Facebook pushes each new comment
// on our Pages as it happens, and the push says who wrote it, which the
// comments API leaves out until the app has Advanced access. We only use the
// push to learn commenters (names, and the id needed to ban them); the
// 10-minute pass still collects the comments themselves.
import { createHmac, timingSafeEqual } from 'crypto';

export type WebhookComment = {
  pageId: string;
  commentId: string;
  postId: string | null;
  verb: string;
  from: { id: string; name?: string } | null;
};

/** Facebook signs each push with the app secret: X-Hub-Signature-256: sha256=<hex>. */
export function validSignature(raw: Buffer | string | undefined, header: string | undefined, secret: string | undefined) {
  if (!raw || !header || !secret || !header.startsWith('sha256=')) return false;
  const want = createHmac('sha256', secret).update(raw).digest('hex');
  const got = header.slice('sha256='.length);
  if (got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(want, 'hex'));
}

/** A push → the comment changes in it. Other feed events (posts, reactions) are ignored. */
export function parseFeedPush(body: any): WebhookComment[] {
  if (body?.object !== 'page') return [];
  const out: WebhookComment[] = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      const v = change?.value;
      if (change?.field !== 'feed' || v?.item !== 'comment' || !v?.comment_id) continue;
      out.push({
        pageId: String(entry.id),
        commentId: String(v.comment_id),
        postId: v.post_id ? String(v.post_id) : null,
        verb: String(v.verb || ''),
        from: v.from?.id ? { id: String(v.from.id), name: v.from.name ? String(v.from.name) : undefined } : null,
      });
    }
  }
  return out;
}

/** The verify token Facebook echoes when the callback URL is saved: set it, or derive it from the app secret. */
export function verifyToken() {
  if (process.env.BOLT_META_WEBHOOK_TOKEN) return process.env.BOLT_META_WEBHOOK_TOKEN;
  const secret = process.env.FACEBOOK_APP_SECRET;
  return secret ? createHmac('sha256', secret).update('bolt-meta-webhook').digest('hex').slice(0, 24) : '';
}

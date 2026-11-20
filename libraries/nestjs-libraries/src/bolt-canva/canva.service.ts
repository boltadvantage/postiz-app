// Bolt Advantage: Canva for each Postiz workspace — connect, start a design,
// list designs, and bring a design's pages into the media library.
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import {
  authorizeUrl,
  CANVA_SIZES,
  CanvaApi,
  canvaConfigured,
  CanvaDesign,
  canvaRedirectUri,
  canvaReturnUrl,
  CanvaSize,
  canvaToken,
  CanvaTokens,
  editLink,
  pkce,
  readReturnToken,
} from '@gitroom/nestjs-libraries/bolt-canva/canva';

const key = (org: string) => `canva:${org}`;
const AUTH_KEY = (state: string) => `bolt:canva:auth:${state}`;
const RETURN_KEY = (state: string) => `bolt:canva:return:${state}`;
const REFRESH_LOCK = (org: string) => `bolt:canva:refresh:${org}`;
const MAX_PAGES = 10;

export type CanvaMedia = { id: string; path: string; name: string };

@Injectable()
export class CanvaService {
  constructor(private _prisma: PrismaService, private _media: MediaService) {}

  private async load(org: string): Promise<CanvaTokens | null> {
    const row = await this._prisma.boltSetting.findUnique({ where: { key: key(org) } });
    if (!row?.value) return null;
    try {
      return JSON.parse(AuthService.fixedDecryption(row.value));
    } catch {
      return null;
    }
  }

  private async save(org: string, t: CanvaTokens) {
    const value = AuthService.fixedEncryption(JSON.stringify(t));
    await this._prisma.boltSetting.upsert({ where: { key: key(org) }, create: { key: key(org), value }, update: { value } });
  }

  async status(org: string) {
    const t = canvaConfigured() ? await this.load(org) : null;
    return {
      configured: canvaConfigured(),
      connected: !!t,
      name: t?.name || null,
      // what to enter in Canva's Developer Portal
      redirectUrl: canvaRedirectUri(),
      returnUrl: canvaReturnUrl(),
      sizes: Object.entries(CANVA_SIZES).map(([id, s]) => ({ id, ...s })),
    };
  }

  /** Where to send the browser to connect Canva. */
  async connectUrl(org: string) {
    if (!canvaConfigured()) throw new Error('Canva is not set up on this server yet (CANVA_CLIENT_ID and CANVA_CLIENT_SECRET)');
    const state = randomBytes(24).toString('base64url');
    const { verifier, challenge } = pkce();
    await ioRedis.set(AUTH_KEY(state), JSON.stringify({ org, verifier }), 'EX', 900);
    return authorizeUrl(state, challenge);
  }

  /** Canva sent the browser back with a code: keep the tokens. */
  async finishConnect(org: string, code: string, state: string) {
    const raw = await ioRedis.get(AUTH_KEY(state));
    await ioRedis.del(AUTH_KEY(state));
    const saved = raw ? JSON.parse(raw) : null;
    if (!saved || saved.org !== org) throw new Error('This Canva sign-in expired or was started elsewhere. Try Connect again.');
    const t = await canvaToken({ grant_type: 'authorization_code', code, code_verifier: saved.verifier, redirect_uri: canvaRedirectUri() });
    t.name = await new CanvaApi(t.access).profileName();
    await this.save(org, t);
    return { name: t.name || null };
  }

  async disconnect(org: string) {
    await this._prisma.boltSetting.deleteMany({ where: { key: key(org) } });
    return { connected: false };
  }

  /** A working client, refreshing the token first when it's about to run out. */
  private async api(org: string) {
    if (!canvaConfigured()) throw new Error('Canva is not set up on this server yet');
    let t = await this.load(org);
    if (!t) throw new Error('Connect Canva first');
    if (t.expiresAt - Date.now() > 120_000) return new CanvaApi(t.access);
    // refresh tokens work once: only one refresh at a time
    if (await ioRedis.set(REFRESH_LOCK(org), '1', 'EX', 30, 'NX')) {
      try {
        const next = await canvaToken({ grant_type: 'refresh_token', refresh_token: t.refresh });
        t = { ...next, name: t.name };
        await this.save(org, t);
      } catch (err: any) {
        throw new Error(`${err?.message || err}. Reconnect Canva.`);
      } finally {
        await ioRedis.del(REFRESH_LOCK(org));
      }
      return new CanvaApi(t.access);
    }
    await new Promise((r) => setTimeout(r, 3000));
    const fresh = await this.load(org);
    if (!fresh) throw new Error('Connect Canva first');
    return new CanvaApi(fresh.access);
  }

  /**
   * A new blank design at a social size, and the link to open it in Canva.
   * Canva's return button comes back to /canva-return, which imports it.
   */
  async newDesign(org: string, input: { size?: string; width?: number; height?: number; title?: string }) {
    const preset = CANVA_SIZES[(input.size || 'square') as CanvaSize];
    const width = Math.round(Number(input.width) || preset?.width || 1080);
    const height = Math.round(Number(input.height) || preset?.height || 1080);
    if (width < 40 || height < 40 || width > 8000 || height > 8000) throw new Error('Width and height must be 40 to 8000 pixels');
    const design = await (await this.api(org)).createDesign(width, height, input.title || 'Postiz design');
    if (!design?.urls?.edit_url) throw new Error('Canva did not return an editor link');
    const state = randomBytes(18).toString('base64url');
    await ioRedis.set(RETURN_KEY(state), JSON.stringify({ org, designId: design.id }), 'EX', 7 * 86400);
    return { designId: design.id, state, editUrl: editLink(design.urls.edit_url, state) };
  }

  async designs(org: string, query?: string, continuation?: string) {
    const r = await (await this.api(org)).listDesigns(query, continuation);
    return {
      continuation: r.continuation,
      items: r.items.map((d: CanvaDesign) => ({
        id: d.id,
        title: d.title || 'Untitled',
        thumbnail: d.thumbnail?.url || null,
        pages: d.page_count || null,
        updatedAt: d.updated_at ? new Date(d.updated_at * 1000).toISOString() : null,
        editUrl: d.urls?.edit_url || null,
      })),
    };
  }

  /** Export a design's pages and keep them in the media library. */
  async importDesign(org: string, designId: string, opts: { pages?: number[]; format?: 'jpg' | 'png' } = {}): Promise<CanvaMedia[]> {
    const api = await this.api(org);
    const design = await api.getDesign(designId);
    const count = design?.page_count || 1;
    const pages = (opts.pages?.length ? opts.pages : Array.from({ length: count }, (_, i) => i + 1))
      .map((p) => Math.floor(Number(p)))
      .filter((p) => p >= 1 && p <= count)
      .slice(0, MAX_PAGES);
    const urls = await api.exportDesign(designId, opts.format === 'png' ? 'png' : 'jpg', pages);
    const base = (design?.title || 'canva').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'canva';
    const out: CanvaMedia[] = [];
    for (const [i, url] of urls.entries()) {
      const saved: any = await this._media.uploadFromUrl(org, url);
      const name = `${base}${urls.length > 1 ? ` p${pages[i] ?? i + 1}` : ''}.${opts.format === 'png' ? 'png' : 'jpg'}`;
      await this._prisma.media.update({ where: { id: saved.id }, data: { name } }).catch(() => undefined);
      out.push({ id: saved.id, path: saved.path, name });
    }
    return out;
  }

  /** Canva's return button: check Canva signed it, then import that design. */
  async finishReturn(org: string, token: string) {
    const { designId, state } = await readReturnToken(token);
    if (state) {
      const raw = await ioRedis.get(RETURN_KEY(state));
      const saved = raw ? JSON.parse(raw) : null;
      if (saved && saved.org !== org) throw new Error('This design was started in another workspace');
    }
    const media = await this.importDesign(org, designId);
    return { state, designId, media };
  }
}

// Bolt Advantage: saves post and channel stats so history survives and can be analyzed.
import { Injectable, Logger } from '@nestjs/common';
import { Integration } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { fromAnalyticsData, MetricMap, summarize } from '@gitroom/nestjs-libraries/bolt-analytics/metrics';
import { BACKFILL_DAYS, STOP_AFTER_DAYS, byPriority, dayKey, isDue } from '@gitroom/nestjs-libraries/bolt-analytics/schedule';
import { recordChannelUsage } from '@gitroom/nestjs-libraries/bolt-costs/usage';
import { X_HISTORY_READS, X_USER_READ_COST, XAnalytics } from '@gitroom/nestjs-libraries/bolt-analytics/x.analytics';
import { NostrAnalytics } from '@gitroom/nestjs-libraries/bolt-analytics/nostr.analytics';
import {
  FollowerTotal,
  facebookFollowers,
  instagramFollowers,
  linkedinPageFollowers,
  nostrFollowers,
} from '@gitroom/nestjs-libraries/bolt-analytics/followers';

export const SUPPORTED_PROVIDERS = ['x', 'nostr', 'linkedin', 'linkedin-page', 'facebook', 'instagram', 'instagram-standalone'];
// Channels whose past posts we import from the platform (others: posts made in Postiz only).
const BACKFILL_PROVIDERS = ['x', 'nostr'];
const LOCK_KEY = 'bolt-analytics:lock';
export const LAST_RUN_KEY = 'bolt-analytics:last-run';
// Per run, per channel, for providers that make one API call per post.
const PER_POST_CALL_LIMIT = 150;

type Candidate = { id: string; externalId: string; publishedAt: Date; lastSyncedAt: Date | null };

@Injectable()
export class BoltAnalyticsService {
  private readonly _logger = new Logger('BoltAnalytics');

  constructor(
    private _prisma: PrismaService,
    private _integrationManager: IntegrationManager,
    private _refreshIntegrationService: RefreshIntegrationService
  ) {}

  /** Runs one sync pass. Returns false if another pass is already running. */
  async syncAll(organizationId?: string) {
    const locked = await ioRedis.set(LOCK_KEY, new Date().toISOString(), 'EX', 3 * 3600, 'NX');
    if (!locked) {
      return false;
    }
    try {
      const integrations = await this._prisma.integration.findMany({
        where: {
          deletedAt: null,
          disabled: false,
          inBetweenSteps: false,
          refreshNeeded: false,
          type: 'social',
          providerIdentifier: { in: SUPPORTED_PROVIDERS },
          ...(organizationId ? { organizationId } : {}),
        },
      });
      for (const integration of integrations) {
        try {
          await this.syncIntegration(integration);
        } catch (err: any) {
          this._logger.warn(`${integration.providerIdentifier} ${integration.id}: ${err?.message || err}`);
        }
      }
      await ioRedis.set(LAST_RUN_KEY, new Date().toISOString());
      return true;
    } finally {
      await ioRedis.del(LOCK_KEY);
    }
  }

  isRunning() {
    return ioRedis.get(LOCK_KEY).then((v) => !!v);
  }

  async syncIntegration(integration: Integration) {
    const token = await this.ensureToken(integration);
    if (!token) {
      return;
    }
    await this.registerPostizPosts(integration);
    if (BACKFILL_PROVIDERS.includes(integration.providerIdentifier)) {
      await this.backfill(integration, token);
    }
    await this.refreshDue(integration, token);
    await this.channelDaily(integration, token);
  }

  private async ensureToken(integration: Integration) {
    if (!integration.tokenExpiration || dayjs(integration.tokenExpiration).isAfter(dayjs())) {
      return integration.token;
    }
    const refreshed = await this._refreshIntegrationService.refresh(integration, 'bolt-analytics');
    return refreshed ? refreshed.accessToken : null;
  }

  /** Posts published through Postiz in the last 90 days. */
  private async registerPostizPosts(integration: Integration) {
    const posts = await this._prisma.post.findMany({
      where: {
        integrationId: integration.id,
        state: 'PUBLISHED',
        deletedAt: null,
        parentPostId: null,
        releaseId: { notIn: ['', 'missing'] },
        publishDate: { gte: dayjs().subtract(STOP_AFTER_DAYS, 'day').toDate() },
      },
      select: { id: true, releaseId: true, releaseURL: true, content: true, publishDate: true },
    });
    for (const p of posts) {
      if (!p.releaseId) {
        continue;
      }
      const content = this.plain(p.content);
      await this._prisma.analyticsPost.upsert({
        where: { integrationId_externalId: { integrationId: integration.id, externalId: p.releaseId } },
        create: {
          organizationId: integration.organizationId,
          integrationId: integration.id,
          externalId: p.releaseId,
          postId: p.id,
          source: 'postiz',
          publishedAt: p.publishDate,
          url: p.releaseURL,
          content,
        },
        update: { postId: p.id, url: p.releaseURL || undefined, content },
      });
    }
  }

  /** One-time import of the last 90 days of posts made outside Postiz. Resumes across runs. */
  private async backfill(integration: Integration, token: string) {
    const state = await this._prisma.analyticsBackfill.findUnique({ where: { integrationId: integration.id } });
    if (state?.done) {
      return;
    }
    const since = state?.untilDate || dayjs().subtract(BACKFILL_DAYS, 'day').toDate();
    if (!state) {
      await this._prisma.analyticsBackfill.create({ data: { integrationId: integration.id, untilDate: since } });
    }

    if (integration.providerIdentifier === 'nostr') {
      const nostr = new NostrAnalytics();
      const relays = await nostr.relaysFor(integration.internalId);
      try {
        const notes = await nostr.recentNotes(relays, integration.internalId, since);
        for (const n of notes) {
          await this.upsertImported(integration, n.id, new Date(n.created_at * 1000), `https://primal.net/e/${n.id}`, n.content);
        }
      } finally {
        nostr.close(relays);
      }
      await this._prisma.analyticsBackfill.update({ where: { integrationId: integration.id }, data: { done: true } });
      return;
    }

    if (integration.providerIdentifier === 'x') {
      const x = new XAnalytics(token);
      let cursor = state?.cursor || undefined;
      while (true) {
        const budget = await this.xBudgetLeft();
        if (budget < 5) {
          return; // continue tomorrow, cursor saved
        }
        const page = await x.timelinePage(integration.internalId, since, budget, cursor);
        await this.addXReads(Math.max(page.posts.length, 1), integration);
        for (const p of page.posts) {
          const row = await this.upsertImported(integration, p.id, p.createdAt, `https://x.com/i/status/${p.id}`, p.text);
          await this.save(row.id, p.metrics);
        }
        cursor = page.next;
        await this._prisma.analyticsBackfill.update({
          where: { integrationId: integration.id },
          data: { cursor: cursor || null, done: !cursor },
        });
        if (!cursor) {
          return;
        }
      }
    }
  }

  private upsertImported(integration: Integration, externalId: string, publishedAt: Date, url: string, content: string) {
    return this._prisma.analyticsPost.upsert({
      where: { integrationId_externalId: { integrationId: integration.id, externalId } },
      create: {
        organizationId: integration.organizationId,
        integrationId: integration.id,
        externalId,
        source: 'imported',
        publishedAt,
        url,
        content: this.plain(content),
      },
      // a post Postiz published keeps its link to the Postiz post
      update: {},
    });
  }

  private async refreshDue(integration: Integration, token: string) {
    const now = new Date();
    const candidates: Candidate[] = await this._prisma.analyticsPost.findMany({
      where: {
        integrationId: integration.id,
        publishedAt: { gte: dayjs().subtract(STOP_AFTER_DAYS, 'day').toDate(), lte: now },
        OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lte: dayjs().subtract(20, 'hour').toDate() } }],
      },
      select: { id: true, externalId: true, publishedAt: true, lastSyncedAt: true },
    });
    const due = byPriority(candidates.filter((c) => isDue(c.publishedAt, c.lastSyncedAt, now)));
    if (due.length === 0) {
      return;
    }

    switch (integration.providerIdentifier) {
      case 'x': {
        const budget = await this.xBudgetLeft();
        const batch = due.slice(0, budget);
        if (batch.length === 0) {
          return;
        }
        const metrics = await new XAnalytics(token).lookup(batch.map((b) => b.externalId));
        await this.addXReads(batch.length, integration);
        for (const b of batch) {
          if (metrics[b.externalId]) {
            await this.save(b.id, metrics[b.externalId]);
          }
        }
        return;
      }
      case 'nostr': {
        const nostr = new NostrAnalytics();
        const relays = await nostr.relaysFor(integration.internalId);
        try {
          const counts = await nostr.engagement(relays, due.map((d) => d.externalId), integration.internalId);
          for (const d of due) {
            await this.save(d.id, counts[d.externalId]);
          }
        } finally {
          nostr.close(relays);
        }
        return;
      }
      default: {
        const provider = this._integrationManager.getSocialIntegration(integration.providerIdentifier);
        if (!provider?.postAnalytics) {
          return; // e.g. personal LinkedIn: the API offers no per-post stats
        }
        for (const d of due.slice(0, PER_POST_CALL_LIMIT)) {
          try {
            const data = await provider.postAnalytics(integration.internalId, token, d.externalId, STOP_AFTER_DAYS);
            await this.save(d.id, fromAnalyticsData(data));
          } catch (err: any) {
            this._logger.warn(`${integration.providerIdentifier} post ${d.externalId}: ${err?.message || err}`);
          }
        }
      }
    }
  }

  /**
   * The real follower total and channel-level metrics, once per channel per day.
   * Followers always come from the platform's own total, never from its daily
   * "new followers" metric. A day whose total failed is retried on the next pass.
   */
  private async channelDaily(integration: Integration, token: string) {
    const date = dayKey();
    const existing = await this._prisma.analyticsChannelDaily.findUnique({
      where: { integrationId_date: { integrationId: integration.id, date } },
    });
    if (existing && existing.followers != null) {
      return;
    }

    let metrics: MetricMap = existing ? JSON.parse(existing.metrics || '{}') : {};
    if (!existing && !['x', 'nostr'].includes(integration.providerIdentifier)) {
      const provider = this._integrationManager.getSocialIntegration(integration.providerIdentifier);
      if (provider?.analytics) {
        try {
          metrics = fromAnalyticsData(await provider.analytics(integration.internalId, token, 1));
        } catch (err: any) {
          this._logger.warn(`${integration.providerIdentifier} channel metrics: ${err?.message || err}`);
        }
      }
    }

    let followers: number | null = null;
    try {
      const total = await this.followerTotal(integration, token);
      if (total === 'skip') {
        return;
      }
      followers = total.followers;
      metrics = { ...metrics, ...(total.extra || {}) };
    } catch (err: any) {
      this._logger.warn(`${integration.providerIdentifier} followers: ${err?.message || err}`);
    }

    await this._prisma.analyticsChannelDaily.upsert({
      where: { integrationId_date: { integrationId: integration.id, date } },
      create: { integrationId: integration.id, organizationId: integration.organizationId, date, followers, metrics: JSON.stringify(metrics) },
      update: { followers, metrics: JSON.stringify(metrics) },
    });
  }

  /** 'skip' leaves the day open (X out of budget) so a later pass fills it. */
  private async followerTotal(integration: Integration, token: string): Promise<FollowerTotal | 'skip'> {
    switch (integration.providerIdentifier) {
      case 'x': {
        if ((await this.xBudgetLeft()) < X_USER_READ_COST) {
          return 'skip';
        }
        await this.addXReads(X_USER_READ_COST, integration);
        return { followers: await new XAnalytics(token).followers() };
      }
      case 'nostr':
        return nostrFollowers(integration.internalId);
      case 'facebook':
        return facebookFollowers(integration.internalId, token);
      case 'instagram':
        return instagramFollowers(integration.internalId, token, 'graph.facebook.com');
      case 'instagram-standalone':
        return instagramFollowers(integration.internalId, token, 'graph.instagram.com');
      case 'linkedin-page':
        return linkedinPageFollowers(integration.internalId, token);
      default:
        // personal LinkedIn: see followers.ts
        return { followers: null };
    }
  }

  private async save(analyticsPostId: string, metrics: MetricMap | undefined) {
    if (!metrics) {
      return;
    }
    const s = summarize(metrics);
    const json = JSON.stringify(s.metrics);
    await this._prisma.analyticsPost.update({
      where: { id: analyticsPostId },
      data: { metrics: json, impressions: s.impressions, engagement: s.engagement, lastSyncedAt: new Date() },
    });
    await this._prisma.analyticsSnapshot.create({
      data: { analyticsPostId, metrics: json, impressions: s.impressions, engagement: s.engagement },
    });
  }

  async xReadsToday() {
    const row = await this._prisma.analyticsApiUsage.findUnique({
      where: { provider_date: { provider: 'x', date: dayKey() } },
    });
    return row?.reads || 0;
  }

  private async xBudgetLeft() {
    return Math.max(0, X_HISTORY_READS() - (await this.xReadsToday()));
  }

  private async addXReads(reads: number, integration: Integration) {
    await recordChannelUsage(this._prisma, integration, 'history', reads);
    return this._prisma.analyticsApiUsage.upsert({
      where: { provider_date: { provider: 'x', date: dayKey() } },
      create: { provider: 'x', date: dayKey(), reads },
      update: { reads: { increment: reads } },
    });
  }

  private plain(content: string | null) {
    if (!content) {
      return null;
    }
    try {
      return stripHtmlValidation('none', content, false, true).slice(0, 500);
    } catch {
      return content.replace(/<[^>]+>/g, ' ').slice(0, 500);
    }
  }
}

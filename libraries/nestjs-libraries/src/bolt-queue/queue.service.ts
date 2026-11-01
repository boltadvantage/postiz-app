// Bolt Advantage: per-channel posting queues with per-weekday times and
// suggestions from saved analytics.
import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { BoltAnalyticsQueries } from '@gitroom/nestjs-libraries/bolt-analytics/bolt-analytics.queries';
import { isValidTimeZone, minuteKey, nextSlots, normalizeSlots, Slot } from '@gitroom/nestjs-libraries/bolt-queue/slots';

const HORIZON_DAYS = 90;
// below this many posts with stats, a channel's own pattern is mostly noise
const MIN_CHANNEL_SAMPLE = 20;

export type Suggestion = {
  day: number;
  minute: number;
  posts: number;
  avgEngagement: number;
  /** vs the data set's average engagement per post, e.g. 0.45 = 45% better */
  lift: number;
};

/** Turn a best-times grid into ranked suggestions per weekday. */
export function rankSuggestions(
  grid: Array<{ weekday: number; hour: number; posts: number; avgEngagement: number }>,
  perDay = 3,
  minPosts = 2
): Suggestion[] {
  const totalPosts = grid.reduce((s, g) => s + g.posts, 0);
  const avg = totalPosts ? grid.reduce((s, g) => s + g.avgEngagement * g.posts, 0) / totalPosts : 0;
  const out: Suggestion[] = [];
  for (let day = 0; day < 7; day++) {
    grid
      .filter((g) => g.weekday === day && g.posts >= minPosts && g.avgEngagement > 0)
      .sort((a, b) => b.avgEngagement - a.avgEngagement || b.posts - a.posts)
      .slice(0, perDay)
      .forEach((g) =>
        out.push({
          day,
          minute: g.hour * 60,
          posts: g.posts,
          avgEngagement: g.avgEngagement,
          lift: avg ? Math.round((g.avgEngagement / avg - 1) * 100) / 100 : 0,
        })
      );
  }
  return out.sort((a, b) => a.day - b.day || a.minute - b.minute);
}

@Injectable()
export class QueueService {
  constructor(
    private _prisma: PrismaService,
    private _analytics: BoltAnalyticsQueries
  ) {}

  private channels(organizationId: string) {
    return this._prisma.integration.findMany({
      where: { organizationId, deletedAt: null, disabled: false, type: 'social', inBetweenSteps: false },
      select: { id: true, name: true, picture: true, providerIdentifier: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  private async load(integrationId: string) {
    const q = await this._prisma.channelQueue.findUnique({ where: { integrationId } });
    return q ? { ...q, slots: normalizeSlots(JSON.parse(q.slots || '[]')) } : null;
  }

  /** Minutes already used by this channel's scheduled or published posts. */
  private async taken(integrationId: string, from: Date) {
    const posts = await this._prisma.post.findMany({
      where: {
        integrationId,
        deletedAt: null,
        parentPostId: null,
        state: { in: ['QUEUE', 'PUBLISHED'] },
        publishDate: { gte: from, lte: dayjs(from).add(HORIZON_DAYS, 'day').toDate() },
      },
      select: { publishDate: true },
    });
    return new Set(posts.map((p) => minuteKey(p.publishDate)));
  }

  /** Next free queue times for one channel, or null when it has no active queue. */
  async next(organizationId: string, integrationId: string, count = 1, from = new Date()) {
    const q = await this.load(integrationId);
    if (!q || q.organizationId !== organizationId || q.paused || q.slots.length === 0) {
      return null;
    }
    return nextSlots({
      slots: q.slots,
      timeZone: q.timeZone,
      from,
      taken: await this.taken(integrationId, from),
      count,
      horizonDays: HORIZON_DAYS,
    });
  }

  /** Earliest free queue time across the organization's channels (for "new post"). */
  async earliest(organizationId: string) {
    const queues = await this._prisma.channelQueue.findMany({ where: { organizationId, paused: false } });
    let best: Date | null = null;
    for (const q of queues) {
      const [n] = (await this.next(organizationId, q.integrationId, 1)) || [];
      if (n && (!best || n < best)) {
        best = n;
      }
    }
    return best;
  }

  async list(organizationId: string) {
    const now = new Date();
    const weekEnd = dayjs(now).add(7, 'day').toDate();
    const channels = await this.channels(organizationId);
    return Promise.all(
      channels.map(async (integration) => {
        const queue = await this.load(integration.id);
        const scheduled = await this._prisma.post.findMany({
          where: {
            integrationId: integration.id,
            deletedAt: null,
            parentPostId: null,
            state: 'QUEUE',
            publishDate: { gte: now, lte: weekEnd },
          },
          orderBy: { publishDate: 'asc' },
          select: { id: true, group: true, publishDate: true, content: true },
        });
        // every queue time this week, filled or open
        const allSlots =
          queue && !queue.paused
            ? nextSlots({ slots: queue.slots, timeZone: queue.timeZone, from: now, count: 200, horizonDays: 7 })
            : [];
        const byMinute = new Map(scheduled.map((p) => [minuteKey(p.publishDate), p]));
        const week = [
          ...allSlots.map((at) => {
            const post = byMinute.get(minuteKey(at));
            return { at, kind: post ? 'filled' : 'open', post: post ? this.preview(post) : null };
          }),
          // posts scheduled outside queue times still belong in the picture
          ...scheduled
            .filter((p) => !allSlots.some((at) => minuteKey(at) === minuteKey(p.publishDate)))
            .map((p) => ({ at: p.publishDate, kind: 'custom', post: this.preview(p) })),
        ].sort((a, b) => a.at.getTime() - b.at.getTime());
        return {
          integration,
          queue: queue ? { timeZone: queue.timeZone, slots: queue.slots, paused: queue.paused } : null,
          next: queue ? (await this.next(organizationId, integration.id, 1))?.[0] || null : null,
          week,
        };
      })
    );
  }

  private preview(p: { id: string; group: string; content: string }) {
    return { id: p.id, group: p.group, text: (p.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140) };
  }

  async save(
    organizationId: string,
    integrationId: string,
    body: { timeZone?: string; slots?: unknown; paused?: boolean }
  ) {
    const integration = await this._prisma.integration.findFirst({
      where: { id: integrationId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!integration) {
      throw new Error('Channel not found');
    }
    const timeZone = body.timeZone && isValidTimeZone(body.timeZone) ? body.timeZone : null;
    if (!timeZone) {
      throw new Error('Pick a valid timezone');
    }
    const slots = JSON.stringify(normalizeSlots(body.slots));
    const paused = !!body.paused;
    await this._prisma.channelQueue.upsert({
      where: { integrationId },
      create: { integrationId, organizationId, timeZone, slots, paused },
      update: { timeZone, slots, paused },
    });
    return this.load(integrationId);
  }

  /** Suggested times per weekday from saved analytics, with how sure we are. */
  async suggestions(organizationId: string, integrationId: string, timeZone: string) {
    const own = await this._analytics.bestTimes(organizationId, integrationId, timeZone);
    if (own.sampleSize >= MIN_CHANNEL_SAMPLE) {
      return { source: 'channel', sampleSize: own.sampleSize, timeZone, suggestions: rankSuggestions(own.grid) };
    }
    const all = await this._analytics.bestTimes(organizationId, undefined, timeZone);
    return {
      source: all.sampleSize > own.sampleSize ? 'all-channels' : 'channel',
      sampleSize: Math.max(all.sampleSize, own.sampleSize),
      channelSampleSize: own.sampleSize,
      timeZone,
      suggestions: rankSuggestions((all.sampleSize > own.sampleSize ? all : own).grid),
    };
  }
}

export type { Slot };

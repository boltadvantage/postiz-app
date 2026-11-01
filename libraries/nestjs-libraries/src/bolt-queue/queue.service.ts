// Bolt Advantage: per-channel posting queues with per-weekday times and
// suggestions from saved analytics.
import { Injectable } from '@nestjs/common';
import dayjs from 'dayjs';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { BoltAnalyticsQueries } from '@gitroom/nestjs-libraries/bolt-analytics/bolt-analytics.queries';
import dayjsTz from 'dayjs/plugin/timezone';
import dayjsUtc from 'dayjs/plugin/utc';
import {
  isValidTimeZone,
  minuteKey,
  nextSlots,
  normalizeDaysOff,
  normalizePerDay,
  normalizeSlots,
  pickDayTimes,
  Slot,
} from '@gitroom/nestjs-libraries/bolt-queue/slots';

dayjs.extend(dayjsUtc);
dayjs.extend(dayjsTz);

const HORIZON_DAYS = 90;
// below this many posts with stats, a channel's own pattern is mostly noise
const MIN_CHANNEL_SAMPLE = 20;

export type Suggestion = {
  day: number;
  minute: number;
  posts: number;
  avgEngagement: number;
  /** cautious score vs the average engagement per post, e.g. 0.45 = 45% better */
  lift: number;
};

/** Turn a best-times grid into ranked suggestions per weekday. */
export function rankSuggestions(
  grid: Array<{ weekday: number; hour: number; posts: number; avgEngagement: number; score: number }>,
  perDay = 3,
  minPosts = 2
): Suggestion[] {
  const totalPosts = grid.reduce((s, g) => s + g.posts, 0);
  const avg = totalPosts ? grid.reduce((s, g) => s + g.avgEngagement * g.posts, 0) / totalPosts : 0;
  // rank on the cautious score and only suggest slots that beat the average
  const out: Suggestion[] = [];
  for (let day = 0; day < 7; day++) {
    grid
      .filter((g) => g.weekday === day && g.posts >= minPosts && g.score > avg)
      .sort((a, b) => b.score - a.score || b.posts - a.posts)
      .slice(0, perDay)
      .forEach((g) =>
        out.push({
          day,
          minute: g.hour * 60,
          posts: g.posts,
          avgEngagement: g.avgEngagement,
          lift: avg ? Math.round((g.score / avg - 1) * 100) / 100 : 0,
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
    if (!q) return null;
    const parse = (v: string, fallback: unknown) => {
      try {
        return JSON.parse(v);
      } catch {
        return fallback;
      }
    };
    return {
      ...q,
      slots: normalizeSlots(parse(q.slots, [])),
      daysOff: normalizeDaysOff(parse(q.daysOff, [])),
      perDay: normalizePerDay(parse(q.perDay, {})),
    };
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
      daysOff: new Set(q.daysOff),
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
            ? nextSlots({ slots: queue.slots, timeZone: queue.timeZone, from: now, count: 200, horizonDays: 7, daysOff: new Set(queue.daysOff) })
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
          queue: queue
            ? {
                timeZone: queue.timeZone,
                slots: queue.slots,
                paused: queue.paused,
                daysOff: queue.daysOff,
                perDay: queue.perDay,
                autoAdjust: queue.autoAdjust,
                lastAdjustedAt: queue.lastAdjustedAt,
              }
            : null,
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
    body: { timeZone?: string; slots?: unknown; paused?: boolean; daysOff?: unknown; perDay?: unknown; autoAdjust?: boolean }
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
    // fields left out keep their saved value (days off are saved on their own)
    const data = {
      timeZone,
      slots: JSON.stringify(normalizeSlots(body.slots)),
      paused: !!body.paused,
      ...(body.daysOff !== undefined ? { daysOff: JSON.stringify(normalizeDaysOff(body.daysOff)) } : {}),
      ...(body.perDay !== undefined ? { perDay: JSON.stringify(normalizePerDay(body.perDay)) } : {}),
      ...(body.autoAdjust !== undefined ? { autoAdjust: !!body.autoAdjust } : {}),
    };
    await this._prisma.channelQueue.upsert({
      where: { integrationId },
      create: { integrationId, organizationId, ...data },
      update: data,
    });
    return this.load(integrationId);
  }

  /** Save only the days off (toggled from the week view without touching other edits). */
  async setDaysOff(organizationId: string, integrationId: string, daysOff: unknown, timeZone?: string) {
    const integration = await this._prisma.integration.findFirst({ where: { id: integrationId, organizationId, deletedAt: null }, select: { id: true } });
    if (!integration) throw new Error('Channel not found');
    const tz = timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC';
    const value = JSON.stringify(normalizeDaysOff(daysOff));
    await this._prisma.channelQueue.upsert({
      where: { integrationId },
      create: { integrationId, organizationId, timeZone: tz, daysOff: value },
      update: { daysOff: value },
    });
    return this.load(integrationId);
  }

  /**
   * Pick the best times for each weekday from the channel's posts-per-day
   * counts, replacing that day's times. Days with a count of 0 are cleared;
   * days without a count are left as they are.
   */
  async autoPick(organizationId: string, integrationId: string, perDayInput?: unknown) {
    const q = await this.load(integrationId);
    if (!q || q.organizationId !== organizationId) throw new Error('Set up this queue first');
    const perDay = perDayInput !== undefined ? normalizePerDay(perDayInput) : q.perDay;
    const days = Object.keys(perDay).map(Number);
    if (!days.length) throw new Error('Set how many posts you want on at least one day');
    const sug = await this.suggestions(organizationId, integrationId, q.timeZone);
    const overall = sug.overallAvg;
    const slots = [
      ...q.slots.filter((s) => !days.includes(s.day)),
      ...days.flatMap((d) => pickDayTimes(d, sug.grid.filter((g) => g.weekday === d), perDay[d], overall)),
    ];
    await this._prisma.channelQueue.update({
      where: { integrationId },
      data: { slots: JSON.stringify(normalizeSlots(slots)), perDay: JSON.stringify(perDay), lastAdjustedAt: new Date() },
    });
    return this.load(integrationId);
  }

  /**
   * Weekly refresh: queues with "keep times updated" are re-picked on Sunday
   * from 5 AM in their own timezone, once per week.
   */
  async adjustDue(now = new Date()) {
    const queues = await this._prisma.channelQueue.findMany({ where: { autoAdjust: true } });
    let adjusted = 0;
    for (const q of queues) {
      if (!isValidTimeZone(q.timeZone)) continue;
      const local = dayjs(now).tz(q.timeZone);
      if (local.day() !== 0 || local.hour() < 5) continue;
      const thisSunday5 = local.startOf('day').add(5, 'hour');
      if (q.lastAdjustedAt && dayjs(q.lastAdjustedAt).isAfter(thisSunday5.subtract(1, 'minute'))) continue;
      try {
        await this.autoPick(q.organizationId, q.integrationId);
        adjusted += 1;
      } catch {
        /* nothing to pick for this queue */
      }
    }
    return adjusted;
  }

  /** Suggested times per weekday from saved analytics, with how sure we are. */
  async suggestions(organizationId: string, integrationId: string, timeZone: string) {
    const own = await this._analytics.bestTimes(organizationId, integrationId, timeZone);
    if (own.sampleSize >= MIN_CHANNEL_SAMPLE) {
      return { source: 'channel', sampleSize: own.sampleSize, timeZone, suggestions: rankSuggestions(own.grid), grid: own.grid, overallAvg: own.overallAvg };
    }
    const all = await this._analytics.bestTimes(organizationId, undefined, timeZone);
    const use = all.sampleSize > own.sampleSize ? all : own;
    return {
      source: all.sampleSize > own.sampleSize ? 'all-channels' : 'channel',
      sampleSize: Math.max(all.sampleSize, own.sampleSize),
      channelSampleSize: own.sampleSize,
      timeZone,
      suggestions: rankSuggestions(use.grid),
      grid: use.grid,
      overallAvg: use.overallAvg,
    };
  }
}

export type { Slot };

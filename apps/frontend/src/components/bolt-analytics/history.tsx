'use client';

// Bolt Advantage: saved analytics — how each channel is doing over time, the
// posts that worked, and the hours your audience responds to.
import React, { FC, useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import clsx from 'clsx';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { ChannelAvatar } from '@gitroom/frontend/components/bolt-shared/channel.avatar';
dayjs.extend(relativeTime);

type Channel = { id: string; name: string; picture: string | null; providerIdentifier: string };
type Summary = {
  integration: Channel;
  posts: number;
  impressions: number;
  engagement: number;
  avgEngagement: number;
  previous: { posts: number; impressions: number; engagement: number };
  followers: number | null;
  followersChange: number | null;
  followersChangePct: number | null;
  trackingSince: string | null;
  followersDaily: { date: string; followers: number }[];
  synced: number;
  daily: { date: string; posts: number; engagement: number; impressions: number }[];
};
type PostRow = {
  id: string;
  integrationId: string;
  publishedAt: string;
  url: string | null;
  content: string | null;
  source: string;
  impressions: number;
  engagement: number;
  lastSyncedAt: string | null;
  metrics: Record<string, number>;
};
type Status = {
  running: boolean;
  lastRun: string | null;
  savedPosts: number;
  xSpendToday: number;
  xDailyUsd: number;
};
type Best = {
  timeZone: string;
  sampleSize: number;
  grid: { weekday: number; hour: number; posts: number; avgEngagement: number }[];
  recommended: number[][];
};

const PERIODS = [7, 30, 90];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const num = (n: number | null | undefined) => (n == null ? '—' : Intl.NumberFormat('en-US', { notation: 'compact' }).format(n));
const hourLabel = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}`;
const NO_IMPRESSIONS = ['nostr'];

const Change: FC<{ now: number; before: number }> = ({ now, before }) => {
  if (!before) return null;
  const pct = Math.round(((now - before) / before) * 100);
  return (
    <span className={clsx('text-[12px] ms-[6px]', pct >= 0 ? 'text-green-400' : 'text-red-400')}>
      {pct >= 0 ? '▲' : '▼'} {Math.abs(pct)}%
    </span>
  );
};

// Bolt Advantage: follower totals over the period (real totals, one point per day)
const FollowerLine: FC<{ points: Summary['followersDaily'] }> = ({ points }) => {
  if (points.length < 2) return null;
  const values = points.map((p) => p.followers);
  const min = Math.min(...values);
  const span = Math.max(1, Math.max(...values) - min);
  const coords = points
    .map((p, i) => `${(i / (points.length - 1)) * 100},${28 - ((p.followers - min) / span) * 24}`)
    .join(' ');
  const first = points[0];
  const last = points[points.length - 1];
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="w-full h-[30px]" aria-hidden>
      <title>{`${dayjs(first.date).format('MMM D')}: ${first.followers.toLocaleString()} → ${dayjs(last.date).format('MMM D')}: ${last.followers.toLocaleString()}`}</title>
      <polyline points={coords} fill="none" stroke={last.followers >= first.followers ? '#4ade80' : '#f87171'} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

const Bars: FC<{ daily: Summary['daily']; days: number }> = ({ daily, days }) => {
  const series = useMemo(() => {
    const byDate = new Map(daily.map((d) => [d.date, d.engagement]));
    return Array.from({ length: days }, (_, i) => {
      const date = dayjs().subtract(days - 1 - i, 'day').format('YYYY-MM-DD');
      return { date, value: byDate.get(date) || 0 };
    });
  }, [daily, days]);
  const max = Math.max(1, ...series.map((s) => s.value));
  return (
    <div className="flex items-end gap-[2px] h-[48px]">
      {series.map((s) => (
        <div
          key={s.date}
          title={`${dayjs(s.date).format('MMM D')}: ${s.value} engagement`}
          className="flex-1 rounded-t-[2px] bg-[#612BD3]"
          style={{ height: `${Math.max(2, (s.value / max) * 100)}%`, opacity: s.value ? 1 : 0.2 }}
        />
      ))}
    </div>
  );
};

const BestTimes: FC<{ data?: Best }> = ({ data }) => {
  const t = useT();
  if (!data) return <LoadingComponent />;
  const cell = new Map(data.grid.map((g) => [`${g.weekday}:${g.hour}`, g]));
  const max = Math.max(1, ...data.grid.map((g) => g.avgEngagement));
  if (data.sampleSize < 5) {
    return (
      <div className="text-[14px] text-textItemBlur">
        {t('best_times_not_enough', 'Not enough saved posts yet to suggest times. Suggestions appear once there are a few weeks of posts with stats.')}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-[8px] overflow-x-auto">
      <div className="grid gap-[2px] min-w-[720px]" style={{ gridTemplateColumns: '40px repeat(24, 1fr)' }}>
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="text-[10px] text-textItemBlur text-center">
            {h % 3 === 0 ? hourLabel(h) : ''}
          </div>
        ))}
        {WEEKDAYS.map((day, w) => (
          <React.Fragment key={day}>
            <div className="text-[12px] text-textItemBlur flex items-center">{day}</div>
            {Array.from({ length: 24 }, (_, h) => {
              const c = cell.get(`${w}:${h}`);
              const best = data.recommended[w]?.includes(h);
              return (
                <div
                  key={h}
                  title={c ? `${day} ${hourLabel(h)}: ${c.avgEngagement} avg engagement over ${c.posts} post${c.posts === 1 ? '' : 's'}` : `${day} ${hourLabel(h)}: no posts`}
                  className="h-[22px] rounded-[3px]"
                  style={{
                    boxShadow: best ? 'inset 0 0 0 2px #fff' : undefined,
                    background: c ? `rgba(97, 43, 211, ${0.15 + 0.85 * (c.avgEngagement / max)})` : 'var(--color-newTableHeader, rgba(255,255,255,0.04))',
                  }}
                />
              );
            })}
          </React.Fragment>
        ))}
      </div>
      <div className="text-[12px] text-textItemBlur">
        {t('best_times_legend', 'Darker = more engagement per post. Outlined = suggested hours (at least 2 posts). Based on {{n}} posts from the last 90 days.', {
          n: data.sampleSize,
        })}{' '}
        {t('times_in', 'Times in')} {data.timeZone.replace(/_/g, ' ')}.
      </div>
    </div>
  );
};

export const History = () => {
  const t = useT();
  const fetch = useFetch();
  const toaster = useToaster();
  const { backendUrl } = useVariables();
  const [days, setDays] = useState(30);
  const [channel, setChannel] = useState<string>('');
  const [sort, setSort] = useState<'engagement' | 'impressions' | 'date'>('engagement');
  const [page, setPage] = useState(0);

  const get = useCallback(async (url: string) => (await fetch(url)).json(), []);
  const { data: status, mutate: refreshStatus } = useSWR<Status>('/bolt-analytics/status', get, { refreshInterval: 15000 });
  const { data: summary } = useSWR<Summary[]>(`/bolt-analytics/summary?days=${days}`, get);
  const timeZone = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
  const { data: best } = useSWR<Best>(`/bolt-analytics/best-times?integrationId=${channel}&timeZone=${encodeURIComponent(timeZone)}`, get);
  const { data: posts } = useSWR<{ total: number; pages: number; posts: PostRow[] }>(
    `/bolt-analytics/posts?days=${days}&integrationId=${channel}&sort=${sort}&page=${page}`,
    get
  );
  const channels = useMemo(() => new Map((summary || []).map((s) => [s.integration.id, s.integration])), [summary]);
  const selected = summary?.find((s) => s.integration.id === channel);

  const syncNow = useCallback(async () => {
    const res = await (await fetch('/bolt-analytics/sync', { method: 'POST' })).json();
    toaster.show(
      res.started ? t('sync_started', 'Saving the latest numbers. This can take a few minutes.') : t('sync_running', 'A sync is already running.'),
      'success'
    );
    refreshStatus();
  }, []);

  if (!summary) {
    return (
      <div className="bg-newBgColorInner p-[20px] flex flex-1 items-center justify-center">
        <LoadingComponent />
      </div>
    );
  }

  return (
    <div className="bg-newBgColorInner p-[20px] mobile:p-[12px] flex flex-1 flex-col gap-[20px] overflow-y-auto">
      <div className="flex flex-wrap items-center gap-[12px]">
        <h2 className="text-[20px] font-[500] me-auto">{t('history', 'History')}</h2>
        <div className="flex rounded-[8px] border border-newTableBorder overflow-hidden text-[14px]">
          {PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => {
                setDays(p);
                setPage(0);
              }}
              className={clsx('px-[12px] h-[34px]', days === p ? 'bg-[#612BD3] text-white' : 'hover:bg-newTableHeader')}
            >
              {p}d
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={syncNow}
          disabled={status?.running}
          className="px-[14px] h-[34px] rounded-[8px] border border-newTableBorder text-[14px] whitespace-nowrap disabled:opacity-50"
        >
          {status?.running ? t('syncing', 'Syncing…') : t('sync_now', 'Sync now')}
        </button>
        {/* Bolt Advantage: what each client cost, for invoicing */}
        <a href="/costs" className="px-[14px] h-[34px] rounded-[8px] border border-newTableBorder text-[14px] flex items-center whitespace-nowrap">
          {t('client_costs', 'Client costs')}
        </a>
        <a
          href={`${backendUrl}/bolt-analytics/followers.csv?days=365`}
          className="px-[14px] h-[34px] rounded-[8px] border border-newTableBorder text-[14px] flex items-center whitespace-nowrap"
        >
          {t('download_followers_csv', 'Download followers CSV')}
        </a>
        <a
          href={`${backendUrl}/bolt-analytics/export.csv?days=${days}`}
          className="px-[14px] h-[34px] rounded-[8px] bg-[#612BD3] text-white text-[14px] flex items-center whitespace-nowrap"
        >
          {t('download_csv', 'Download CSV')}
        </a>
      </div>

      {status && (
        <div className="text-[13px] text-textItemBlur -mt-[10px]">
          {status.lastRun
            ? t('last_saved', 'Last saved {{when}}', { when: dayjs(status.lastRun).fromNow() })
            : t('never_saved', 'Not saved yet. The first sync runs a few minutes after startup.')}
          {' · '}
          {t('saved_posts', '{{n}} posts saved', { n: status.savedPosts })}
          {' · '}
          {t('x_spend_today', 'X today: ${{spend}} of ${{cap}}', {
            spend: status.xSpendToday.toFixed(2),
            cap: status.xDailyUsd.toFixed(2),
          })}
        </div>
      )}

      {summary.length === 0 ? (
        <div className="text-[14px] text-textItemBlur">{t('history_no_channels', 'Connect a channel to start saving its history.')}</div>
      ) : (
        <div className="grid grid-cols-3 mobile:grid-cols-1 gap-[12px]">
          {summary.map((s) => (
            <button
              type="button"
              key={s.integration.id}
              onClick={() => {
                setChannel(channel === s.integration.id ? '' : s.integration.id);
                setPage(0);
              }}
              className={clsx(
                'text-start rounded-[8px] bg-newTableHeader p-[16px] flex flex-col gap-[12px] border',
                channel === s.integration.id ? 'border-[#612BD3]' : 'border-transparent'
              )}
            >
              <div className="flex items-center gap-[10px]">
                <ChannelAvatar picture={s.integration.picture} platform={s.integration.providerIdentifier} />
                <div className="flex-1 min-w-0">
                  <div className="truncate">{s.integration.name}</div>
                  <div className="text-[12px] text-textItemBlur">{s.integration.providerIdentifier}</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-[8px] text-[13px]">
                <div>
                  <div className="text-textItemBlur">{t('engagement', 'Engagement')}</div>
                  <div className="text-[18px]">
                    {num(s.engagement)}
                    <Change now={s.engagement} before={s.previous.engagement} />
                  </div>
                </div>
                <div>
                  <div className="text-textItemBlur">{t('posts', 'Posts')}</div>
                  <div className="text-[18px]">
                    {s.posts}
                    <span className="text-[12px] text-textItemBlur ms-[6px]">{t('avg_per_post', '{{n}} avg', { n: s.avgEngagement })}</span>
                  </div>
                </div>
                <div>
                  <div className="text-textItemBlur">{t('impressions', 'Impressions')}</div>
                  <div className="text-[18px]">
                    {NO_IMPRESSIONS.includes(s.integration.providerIdentifier) ? '—' : num(s.impressions)}
                  </div>
                </div>
                <div>
                  <div className="text-textItemBlur">{t('followers', 'Followers')}</div>
                  <div className="text-[18px]">
                    {s.followers == null ? '—' : s.followers.toLocaleString()}
                    {s.followersChange != null && (
                      <span
                        className={clsx(
                          'text-[12px] ms-[6px]',
                          s.followersChange > 0 ? 'text-green-400' : s.followersChange < 0 ? 'text-red-400' : 'text-textItemBlur'
                        )}
                      >
                        {s.followersChange > 0 ? '+' : ''}
                        {s.followersChange.toLocaleString()}
                        {s.followersChangePct != null ? ` (${s.followersChangePct > 0 ? '+' : ''}${s.followersChangePct}%)` : ''}
                      </span>
                    )}
                  </div>
                  {s.followers != null && s.followersChange == null && s.trackingSince && (
                    <div className="text-[11px] text-textItemBlur">
                      {t('tracking_since', 'Tracking since {{date}}', { date: dayjs(s.trackingSince).format('MMM D') })}
                    </div>
                  )}
                </div>
              </div>
              <FollowerLine points={s.followersDaily} />
              <Bars daily={s.daily} days={days} />
            </button>
          ))}
        </div>
      )}

      <div className="rounded-[8px] bg-newTableHeader p-[16px] flex flex-col gap-[12px]">
        <div className="text-[16px]">
          {t('best_times_title', 'When your posts do best')}
          {selected ? ` · ${selected.integration.name}` : ` · ${t('all_channels', 'all channels')}`}
        </div>
        <BestTimes data={best} />
      </div>

      <div className="rounded-[8px] bg-newTableHeader p-[16px] flex flex-col gap-[12px]">
        <div className="flex items-center gap-[12px] flex-wrap">
          <div className="text-[16px] me-auto">
            {t('posts_title', 'Posts')}
            {selected ? ` · ${selected.integration.name}` : ''}
            <span className="text-[13px] text-textItemBlur ms-[8px]">{posts?.total ?? ''}</span>
          </div>
          <div className="flex gap-[6px] text-[13px]">
            {(['engagement', 'impressions', 'date'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setSort(s);
                  setPage(0);
                }}
                className={clsx('px-[10px] h-[28px] rounded-[6px]', sort === s ? 'bg-[#612BD3] text-white' : 'border border-newTableBorder')}
              >
                {s === 'engagement' ? t('top', 'Top') : s === 'impressions' ? t('most_seen', 'Most seen') : t('newest', 'Newest')}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[720px]">
            <thead className="text-textItemBlur text-start">
              <tr>
                <th className="text-start font-normal py-[6px]">{t('date', 'Date')}</th>
                <th className="text-start font-normal">{t('post', 'Post')}</th>
                <th className="text-end font-normal">{t('engagement', 'Engagement')}</th>
                <th className="text-end font-normal">{t('likes', 'Likes')}</th>
                <th className="text-end font-normal">{t('replies', 'Replies')}</th>
                <th className="text-end font-normal">{t('shares', 'Shares')}</th>
                <th className="text-end font-normal">{t('impressions', 'Impressions')}</th>
              </tr>
            </thead>
            <tbody>
              {(posts?.posts || []).map((p) => {
                const ch = channels.get(p.integrationId);
                return (
                  <tr key={p.id} className="border-t border-newTableBorder align-top">
                    <td className="py-[8px] whitespace-nowrap pe-[12px]">
                      <div>{dayjs(p.publishedAt).format('MMM D, h:mma')}</div>
                      <div className="text-[11px] text-textItemBlur">
                        {ch?.providerIdentifier}
                        {p.source === 'imported' ? ` · ${t('imported', 'imported')}` : ''}
                      </div>
                    </td>
                    <td className="py-[8px] pe-[12px] max-w-[420px]">
                      {p.url ? (
                        <a href={p.url} target="_blank" rel="noreferrer" className="hover:underline line-clamp-2">
                          {p.content || p.url}
                        </a>
                      ) : (
                        <span className="line-clamp-2">{p.content}</span>
                      )}
                      {!p.lastSyncedAt && <div className="text-[11px] text-textItemBlur">{t('waiting_for_stats', 'Waiting for first stats')}</div>}
                    </td>
                    <td className="text-end">{p.engagement}</td>
                    <td className="text-end">{p.metrics.likes ?? '—'}</td>
                    <td className="text-end">{p.metrics.comments ?? '—'}</td>
                    <td className="text-end">{p.metrics.shares ?? '—'}</td>
                    <td className="text-end">{NO_IMPRESSIONS.includes(ch?.providerIdentifier || '') ? '—' : num(p.impressions)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {posts && posts.posts.length === 0 && (
            <div className="text-[14px] text-textItemBlur py-[12px]">{t('no_saved_posts', 'No saved posts in this period yet.')}</div>
          )}
        </div>
        {posts && posts.pages > 1 && (
          <div className="flex gap-[8px] justify-end text-[13px]">
            <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} className="px-[10px] h-[28px] rounded-[6px] border border-newTableBorder disabled:opacity-40">
              {t('previous', 'Previous')}
            </button>
            <span className="self-center text-textItemBlur">
              {page + 1} / {posts.pages}
            </span>
            <button type="button" disabled={page >= posts.pages - 1} onClick={() => setPage(page + 1)} className="px-[10px] h-[28px] rounded-[6px] border border-newTableBorder disabled:opacity-40">
              {t('next', 'Next')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

'use client';

// Bolt Advantage: desktop notifications while Postiz is open in a tab — failed
// posts and new mentions, messages and follows — as macOS notifications with a
// sound. Settings live in this browser (Settings → Desktop notifications).
import { FC, useEffect, useRef } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

export type NotifyPrefs = { enabled: boolean; failures: boolean; mentions: boolean; messages: boolean; follows: boolean; sound: boolean };
export const DEFAULT_PREFS: NotifyPrefs = { enabled: false, failures: true, mentions: true, messages: true, follows: true, sound: true };
const PREFS_KEY = 'bolt-notify-prefs';
const STATE_KEY = 'bolt-notify-state';
const POLL_MS = 60_000;

const read = <T,>(key: string, fallback: T): T => {
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') };
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window */
  }
};
export const readPrefs = () => read(PREFS_KEY, DEFAULT_PREFS);
export const savePrefs = (p: NotifyPrefs) => write(PREFS_KEY, p);

/** A short two-note chime (macOS adds its own sound if allowed for the browser). */
export function chime() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    [880, 1318.5].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      const t = ctx.currentTime + i * 0.16;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
    setTimeout(() => ctx.close(), 1200);
  } catch {
    /* no audio */
  }
}

export function notify(title: string, body: string, href: string, tag: string, sound: boolean) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, tag, icon: '/favicon.ico' });
  n.onclick = () => {
    window.focus();
    if (!window.location.pathname.startsWith(href)) window.location.href = href;
    n.close();
  };
  if (sound) chime();
}

const plain = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const plural = (n: number, one: string, many: string) => `${n} new ${n === 1 ? one : many}`;

type State = { at?: string; mentions?: number; messages?: number; follows?: number; polledAt?: number };

export const DesktopNotifier: FC = () => {
  const fetch = useFetch();
  const busy = useRef(false);

  useEffect(() => {
    const tick = async () => {
      const prefs = readPrefs();
      if (!prefs.enabled || typeof Notification === 'undefined' || Notification.permission !== 'granted' || busy.current) return;
      const state = read<State>(STATE_KEY, {});
      // with several Postiz tabs open, only one checks each minute
      if (state.polledAt && Date.now() - state.polledAt < POLL_MS - 5000) return;
      write(STATE_KEY, { ...state, polledAt: Date.now() });
      busy.current = true;
      try {
        const res = await fetch(`/bolt-notify/feed?since=${encodeURIComponent(state.at || new Date().toISOString())}`);
        if (!res.ok) return;
        const feed = await res.json();
        const first = state.mentions === undefined;
        if (!first) {
          const news: string[] = [];
          if (prefs.mentions && feed.mentions > (state.mentions || 0)) news.push(plural(feed.mentions - (state.mentions || 0), 'mention', 'mentions'));
          if (prefs.messages && feed.messages > (state.messages || 0)) news.push(plural(feed.messages - (state.messages || 0), 'message', 'messages'));
          if (prefs.follows && feed.follows > (state.follows || 0)) news.push(plural(feed.follows - (state.follows || 0), 'follower', 'followers'));
          if (news.length) notify('Postiz inbox', news.join(', '), '/inbox', 'bolt-inbox', prefs.sound);
          if (prefs.failures) {
            for (const n of feed.notifications || []) {
              notify('Postiz', plain(n.content).slice(0, 200), '/launches', `bolt-note-${n.id}`, prefs.sound);
            }
          }
        }
        write(STATE_KEY, { at: feed.now, mentions: feed.mentions, messages: feed.messages, follows: feed.follows, polledAt: Date.now() });
      } catch {
        /* offline; try next time */
      } finally {
        busy.current = false;
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, []);

  return null;
};

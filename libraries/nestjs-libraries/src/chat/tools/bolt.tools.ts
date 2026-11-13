// Bolt Advantage: MCP / agent tools for the Bolt features — inbox, direct
// messages, people (tags, mutes), queue and pause, and saved analytics — so
// any connected AI can do what the web app can. They go through BoltApiService,
// the same layer as the public API.
import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Injectable } from '@nestjs/common';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import { BoltApiService } from '@gitroom/nestjs-libraries/bolt-api/bolt.api.service';

const orgId = (inputData: any, context: any) => {
  checkAuth(inputData, context);
  return JSON.parse((context?.requestContext as any)?.get('organization') as string).id as string;
};
// errors come back as output.errors (like the built-in tools) instead of failing the call
const run = async (fn: () => Promise<unknown>) => {
  try {
    return { output: await fn() };
  } catch (e: any) {
    return { output: { errors: e?.message || 'Something went wrong' } };
  }
};
const outputSchema = z.object({ output: z.any() });
const statusField = z
  .enum(['open', 'unread', 'archived', 'all'])
  .optional()
  .describe('"open" (default) = not archived, "unread", "archived" or "all"');
const channelsField = z.array(z.string()).optional().describe('Only these channel (integration) ids');
const read = (title: string) => ({ annotations: { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });
const write = (title: string, openWorld: boolean) => ({
  annotations: { title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: openWorld },
});

@Injectable()
export class BoltInboxListTool implements AgentToolInterface {
  constructor(private _api: BoltApiService) {}
  name = 'boltInboxListTool';
  optionalOnSelfHosted = true;
  run() {
    return createTool({
      id: 'boltInboxListTool',
      mcp: read('List Inbox (mentions, replies, quotes)'),
      description: `
List what people posted at the user's channels: Nostr and X mentions, replies and quotes, and comments on their Facebook Pages' posts (kind "reply", platform "facebook"). Newest first, 50 per page.
Muted people are left out unless showMuted is true. Each item has an "id" (use it with boltInboxRespondTool), the text, who wrote it ("person", with the user's private tags and notes), the post of theirs it answers ("inReplyToText"), and whether it was already read, replied to, reposted or quoted.
Direct messages are separate: use boltConversationsListTool.
`,
      inputSchema: z.object({
        status: statusField,
        channels: channelsField,
        kinds: z.array(z.enum(['mention', 'reply', 'quote'])).optional(),
        tag: z.string().optional().describe('Only people with this private tag'),
        q: z.string().optional().describe('Search text (case-insensitive)'),
        showMuted: z.boolean().optional(),
        page: z.number().int().min(0).optional(),
      }),
      outputSchema,
      execute: async (input, context) => run(() => this._api.inbox(orgId(input, context), input)),
    });
  }
}

@Injectable()
export class BoltFollowsListTool implements AgentToolInterface {
  constructor(private _api: BoltApiService) {}
  name = 'boltFollowsListTool';
  optionalOnSelfHosted = true;
  run() {
    return createTool({
      id: 'boltFollowsListTool',
      mcp: read('List Follows (new followers and Nostr unfollows)'),
      description: `
List people who followed the user's X and Nostr channels (event "follow"), and on Nostr who unfollowed ("unfollow"). Newest first, 50 per page.
Only channels with Follows turned on in the inbox appear, and each channel may show only notable followers (verified, or at least a set number of followers of their own). "followsOff" is true when no channel has Follows on.
Each item has the person (with the user's private tags and notes), their follower count when known, whether they're verified, and whether the user already followed back.
`,
      inputSchema: z.object({
        status: statusField,
        channels: channelsField,
        tag: z.string().optional().describe('Only people with this private tag'),
        q: z.string().optional().describe('Search names and handles'),
        showMuted: z.boolean().optional(),
        page: z.number().int().min(0).optional(),
      }),
      outputSchema,
      execute: async (input, context) => run(() => this._api.follows(orgId(input, context), input)),
    });
  }
}

@Injectable()
export class BoltFollowTool implements AgentToolInterface {
  constructor(private _api: BoltApiService) {}
  name = 'boltFollowTool';
  optionalOnSelfHosted = true;
  run() {
    return createTool({
      id: 'boltFollowTool',
      mcp: write('Follow Someone on X or Nostr', true),
      description: `
Follow someone from one of the user's X or Nostr channels. Either follow back a new follower (followId from boltFollowsListTool; follows from the channel they followed), or follow anyone in the inbox (channelId + personId, the person id from boltInboxListTool, boltConversationsListTool, boltFollowsListTool or boltPeopleTool; the person must be on the channel's platform).
This happens on the social network right away. On X it costs $0.015 from the inbox's X budget. On Nostr it republishes the channel's follow list with the person added, and refuses if the current list can't be found on the relays.
`,
      inputSchema: z.object({
        followId: z.string().optional().describe('Follow id from boltFollowsListTool (follow back)'),
        channelId: z.string().optional().describe('Channel (integration) id to follow from'),
        personId: z.string().optional().describe('Inbox person id to follow'),
      }),
      outputSchema,
      execute: async (input, context) => run(() => this._api.follow(orgId(input, context), input)),
    });
  }
}

@Injectable()
export class BoltInboxRespondTool implements AgentToolInterface {
  constructor(private _api: BoltApiService) {}
  name = 'boltInboxRespondTool';
  optionalOnSelfHosted = true;
  run() {
    return createTool({
      id: 'boltInboxRespondTool',
      mcp: write('Reply / Repost / Quote / Like an Inbox Item', true),
      description: `
Publicly reply to, repost, quote or like an inbox item (from boltInboxListTool) from the channel it arrived on. This posts on the social network right away and cannot be undone from here.
"reply" and "quote" need "text" (X: 280 characters, or 25,000 for X Premium channels). "repost" and "like" take no text. Facebook comments can only be replied to or liked.
Always show the user the exact text and which item it answers, and get their confirmation before calling this.
`,
      inputSchema: z.object({
        itemId: z.string().describe('Inbox item id'),
        action: z.enum(['reply', 'repost', 'quote', 'like']),
        text: z.string().optional(),
      }),
      outputSchema,
      execute: async (input, context) => run(() => this._api.respond(orgId(input, context), input.itemId, input.action, input.text)),
    });
  }
}

@Injectable()
export class BoltInboxMarkTool implements AgentToolInterface {
  constructor(private _api: BoltApiService) {}
  name = 'boltInboxMarkTool';
  optionalOnSelfHosted = true;
  run() {
    return createTool({
      id: 'boltInboxMarkTool',
      mcp: write('Mark Inbox Items or Conversations', false),
      description: `
Mark inbox items (target "items", ids from boltInboxListTool), direct-message conversations (target "conversations", ids from boltConversationsListTool) or follows (target "follows", ids from boltFollowsListTool) as read, unread, archived or unarchived. Only changes the user's inbox, nothing on the social network.
`,
      inputSchema: z.object({
        target: z.enum(['items', 'conversations', 'follows']),
        ids: z.array(z.string()).min(1).max(500),
        action: z.enum(['read', 'unread', 'archive', 'unarchive']),
      }),
      outputSchema,
      execute: async (input, context) =>
        run(() =>
          input.target === 'items'
            ? this._api.markInbox(orgId(input, context), input.ids, input.action)
            : input.target === 'follows'
            ? this._api.markFollows(orgId(input, context), input.ids, input.action)
            : this._api.markConversations(orgId(input, context), input.ids, input.action)
        ),
    });
  }
}

@Injectable()
export class BoltConversationsListTool implements AgentToolInterface {
  constructor(private _api: BoltApiService) {}
  name = 'boltConversationsListTool';
  optionalOnSelfHosted = true;
  run() {
    return createTool({
      id: 'boltConversationsListTool',
      mcp: read('List Direct-Message Conversations'),
      description: `
List the user's one-to-one direct-message conversations on Nostr, X, Facebook Pages (Messenger) and Instagram, most recent first, with the last message, who sent it, unread count and the other person (with private tags and notes).
"problems" lists channels whose messages can't be fetched and why (for example X missing Direct Message permission) - tell the user.
Read a conversation with boltConversationReadTool and answer with boltMessageSendTool.
`,
      inputSchema: z.object({
        status: statusField,
        channels: channelsField,
        tag: z.string().optional(),
        q: z.string().optional().describe('Search people and message text'),
        showMuted: z.boolean().optional(),
        page: z.number().int().min(0).optional(),
      }),
      outputSchema,
      execute: async (input, context) => run(() => this._api.conversations(orgId(input, context), input)),
    });
  }
}

@Injectable()
export class BoltConversationReadTool implements AgentToolInterface {
  constructor(private _api: BoltApiService) {}
  name = 'boltConversationReadTool';
  optionalOnSelfHosted = true;
  run() {
    return createTool({
      id: 'boltConversationReadTool',
      mcp: read('Read a Conversation'),
      description: `
Read the messages in one direct-message conversation, oldest first (up to 100; pass "before" = the oldest sentAt to page back when "more" is true).
Reading here does not mark it read for the user unless markRead is true.
These are private messages: only quote or summarize them to the user who owns the account.
`,
      inputSchema: z.object({
        conversationId: z.string(),
        before: z.string().optional().describe('ISO time; returns messages older than this'),
        markRead: z.boolean().optional(),
      }),
      outputSchema,
      execute: async (input, context) =>
        run(() => this._api.conversation(orgId(input, context), input.conversationId, { before: input.before, markRead: input.markRead })),
    });
  }
}

@Injectable()
export class BoltMessageSendTool implements AgentToolInterface {
  constructor(private _api: BoltApiService) {}
  name = 'boltMessageSendTool';
  optionalOnSelfHosted = true;
  run() {
    return createTool({
      id: 'boltMessageSendTool',
      mcp: write('Send a Direct Message', true),
      description: `
Send a direct message in an existing conversation (from boltConversationsListTool), from the channel it belongs to. It is delivered right away and can't be unsent.
On Nostr it uses the same encryption the other person uses. Facebook (Messenger, up to 2,000 characters) and Instagram (up to 1,000) only allow a reply within 24 hours of the person's last message. Always show the user the exact text and who it goes to, and get their confirmation first.
`,
      inputSchema: z.object({
        conversationId: z.string(),
        text: z.string().min(1),
      }),
      outputSchema,
      execute: async (input, context) => run(() => this._api.sendMessage(orgId(input, context), input.conversationId, input.text)),
    });
  }
}

@Injectable()
export class BoltPeopleTool implements AgentToolInterface {
  constructor(private _api: BoltApiService) {}
  name = 'boltPeopleTool';
  optionalOnSelfHosted = true;
  run() {
    return createTool({
      id: 'boltPeopleTool',
      mcp: write('Inbox People: List, Tag, Mute, Note', false),
      description: `
The people who show up in the inbox and messages, with the user's private tags, notes and mutes (none of this is visible on the social networks; muting doesn't block or notify anyone).
- action "list": everyone (optionally only muted, or with a tag); also returns all tags with counts.
- action "update": set "tags" (replaces the list), "muted", and/or "note" for one person id (person ids come from inbox items and conversations).
Muting hides everything from that person and stops saving their new posts and messages. Confirm with the user before muting someone.
`,
      inputSchema: z.object({
        action: z.enum(['list', 'update']),
        personId: z.string().optional(),
        muted: z.boolean().optional(),
        tag: z.string().optional().describe('list: only people with this tag'),
        tags: z.array(z.string()).optional().describe('update: the full new tag list'),
        note: z.string().nullable().optional(),
      }),
      outputSchema,
      execute: async (input, context) =>
        run(async () => {
          const org = orgId(input, context);
          if (input.action === 'list') {
            return { people: await this._api.people(org, { muted: input.muted, tag: input.tag }), tags: await this._api.tags(org) };
          }
          if (!input.personId) throw new Error('personId is required to update');
          return this._api.updatePerson(org, input.personId, { tags: input.tags, muted: input.muted, note: input.note });
        }),
    });
  }
}

@Injectable()
export class BoltQueueTool implements AgentToolInterface {
  constructor(private _api: BoltApiService) {}
  name = 'boltQueueTool';
  optionalOnSelfHosted = true;
  run() {
    return createTool({
      id: 'boltQueueTool',
      mcp: read('Posting Queue and Pause Status'),
      description: `
The posting queue for every channel: weekly posting times (day 0 = Sunday, minute = minutes after midnight in the queue's timeZone), posts per day, days off, whether times auto-refresh every Sunday, the next open queue times (UTC), and this week's filled/open slots.
Also whether ALL posting is paused ("postingPaused") and how many posts are held.
To "add a post to the queue", take the channel's first nextOpenTimes value and schedule the post at that time with the normal scheduling tool.
`,
      inputSchema: z.object({
        nextCount: z.number().int().min(1).max(20).optional().describe('How many upcoming open times per channel (default 5)'),
      }),
      outputSchema,
      execute: async (input, context) => run(() => this._api.queues(orgId(input, context), input.nextCount)),
    });
  }
}

@Injectable()
export class BoltQueueUpdateTool implements AgentToolInterface {
  constructor(private _api: BoltApiService) {}
  name = 'boltQueueUpdateTool';
  optionalOnSelfHosted = true;
  run() {
    return createTool({
      id: 'boltQueueUpdateTool',
      mcp: write('Change a Channel Queue', false),
      description: `
Change one channel's posting queue. Only the fields you pass change.
- perDay: posts per weekday, e.g. {"1": 3, "5": 1} (0 = Sunday). With pickBestTimes true it then picks that many best times per day from the channel's history.
- slots: the exact weekly times, [{"day": 1, "minute": 540}] = Monday 9:00 AM in timeZone (replaces all times).
- daysOff: dates with no queue posting, ["2026-12-25"] (replaces the list).
- autoAdjust: re-pick best times every Sunday morning.
- paused: pause just this channel's queue (to stop ALL posting use boltPostingPauseTool).
Show the user what will change and get their confirmation first.
`,
      inputSchema: z.object({
        integrationId: z.string(),
        timeZone: z.string().optional(),
        slots: z.array(z.object({ day: z.number().int().min(0).max(6), minute: z.number().int().min(0).max(1439) })).optional(),
        perDay: z.record(z.string(), z.number().int().min(0).max(12)).optional(),
        pickBestTimes: z.boolean().optional(),
        daysOff: z.array(z.string()).optional(),
        autoAdjust: z.boolean().optional(),
        paused: z.boolean().optional(),
      }),
      outputSchema,
      execute: async (input, context) => run(() => this._api.updateQueue(orgId(input, context), input.integrationId, input)),
    });
  }
}

@Injectable()
export class BoltPostingPauseTool implements AgentToolInterface {
  constructor(private _api: BoltApiService) {}
  name = 'boltPostingPauseTool';
  optionalOnSelfHosted = true;
  run() {
    return createTool({
      id: 'boltPostingPauseTool',
      mcp: { annotations: { title: 'Pause or Resume ALL Posting', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
      description: `
Pause (paused: true) or resume (paused: false) ALL posting on every channel immediately.
Pausing stops every scheduled post and holds anything scheduled while paused. Resuming restarts held posts; ones whose time passed while paused move into their channel's next open queue time.
This affects everything the user has scheduled - always get explicit confirmation first.
`,
      inputSchema: z.object({ paused: z.boolean() }),
      outputSchema,
      execute: async (input, context) => run(() => this._api.setPaused(orgId(input, context), input.paused)),
    });
  }
}

@Injectable()
export class BoltAnalyticsTool implements AgentToolInterface {
  constructor(private _api: BoltApiService) {}
  name = 'boltAnalyticsTool';
  optionalOnSelfHosted = true;
  run() {
    return createTool({
      id: 'boltAnalyticsTool',
      mcp: read('Saved Analytics, Followers, Best Times'),
      description: `
Saved analytics history (kept by Postiz every 6 hours, up to a year):
- summary: per channel posts, impressions, engagement for the period vs the previous period, and follower growth.
- followers: daily REAL follower totals per channel. For growth reports always use these totals, never a platform's own "growth" metric (Facebook's don't match reality).
- topPosts: the 20 most engaging posts in the period.
- bestTimes: which weekdays/hours get the most engagement (last 90 days, recent posts weigh more), in timeZone.
`,
      inputSchema: z.object({
        days: z.number().int().min(1).max(365).optional().describe('Period length (default 30)'),
        integrationId: z.string().optional(),
        timeZone: z.string().optional().describe('For bestTimes, e.g. America/Chicago (default UTC)'),
        include: z.array(z.enum(['summary', 'followers', 'topPosts', 'bestTimes'])).optional().describe('Default: all'),
      }),
      outputSchema,
      execute: async (input, context) => run(() => this._api.analytics(orgId(input, context), input)),
    });
  }
}

@Injectable()
export class BoltCostsTool implements AgentToolInterface {
  constructor(private _api: BoltApiService) {}
  name = 'boltCostsTool';
  optionalOnSelfHosted = true;
  run() {
    return createTool({
      id: 'boltCostsTool',
      mcp: read('Client Costs (metered API use)'),
      description: `
What each client cost in metered API use (X reads and posts) over a date range, for invoicing.
Clients are Postiz customers/groups (a channel is put in one from its menu: "Move / add to group"); channels without one are listed under a client with an empty name.
Per channel: items billed for history (saved stats, followers), inbox (mentions), dm (direct messages), and write (replies, reposts, quotes, likes, messages sent), with the USD cost at X's per-item prices (each item billed once per UTC day; the app owner's own data at the cheaper owned price).
"xBudget" is today's install-wide X budget (dailyUsd, inboxUsd, historyUsd) and what has been spent today; an admin changes it in Settings.
Costs are estimates; the X developer console has the real bill. "trackingSince" is when per-channel tracking started - nothing before it is included.
`,
      inputSchema: z.object({
        from: z.string().optional().describe('First day, YYYY-MM-DD (default: first of this month)'),
        to: z.string().optional().describe('Last day, YYYY-MM-DD, inclusive (default: today)'),
      }),
      outputSchema,
      execute: async (input, context) => run(() => this._api.costs(orgId(input, context), input.from, input.to)),
    });
  }
}

export const boltTools = [
  BoltInboxListTool,
  BoltInboxRespondTool,
  BoltInboxMarkTool,
  BoltFollowsListTool,
  BoltFollowTool,
  BoltConversationsListTool,
  BoltConversationReadTool,
  BoltMessageSendTool,
  BoltPeopleTool,
  BoltQueueTool,
  BoltQueueUpdateTool,
  BoltPostingPauseTool,
  BoltAnalyticsTool,
  BoltCostsTool,
];

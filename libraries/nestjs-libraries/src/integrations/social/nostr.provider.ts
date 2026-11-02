import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import dayjs from 'dayjs';
import { SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { getPublicKey, Relay, finalizeEvent, SimplePool, nip19 } from 'nostr-tools';

import WebSocket from 'ws';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { Integration } from '@prisma/client';
import { secretKeyFromHex } from '@gitroom/nestjs-libraries/bolt-inbox/nostr.inbox';

// @ts-ignore
global.WebSocket = WebSocket;

const list = [
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://relay.snort.social',
  'wss://temp.iris.to',
  'wss://vault.iris.to',
];

const pool = new SimplePool();

export class NostrProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 5;
  identifier = 'nostr';
  name = 'Nostr';
  isBetweenSteps = false;
  scopes = [] as string[];
  editor = 'normal' as const;
  toolTip = 'Your Nostr private key: nsec1… or 64-character hex'

  maxLength() {
    return 100000;
  }

  async customFields() {
    return [
      {
        key: 'password',
        label: 'Nostr private key',
        validation: `/^.{3,}$/`,
        type: 'password' as const,
      },
    ];
  }

  async refreshToken(refresh_token: string): Promise<AuthTokenDetails> {
    return {
      refreshToken: '',
      expiresIn: 0,
      accessToken: '',
      id: '',
      name: '',
      picture: '',
      username: '',
    };
  }

  async generateAuthUrl() {
    const state = makeSecureId(17);
    return {
      url: state,
      codeVerifier: makeSecureId(10),
      state,
    };
  }

  // Bolt Advantage: accept nsec1… as well as hex, and refuse anything else.
  // Upstream read every key as hex, so an nsec silently became a different,
  // empty account and posts went there.
  private secretKey(password: string) {
    return secretKeyFromHex(password);
  }

  private async findRelayInformation(pubkey: string) {
    // This queries ALL relays in parallel and resolves with
    // the first matching event from ANY relay.
    const evt = await pool.get(list, {
      kinds: [0],
      authors: [pubkey],
      limit: 1,
    });

    if (!evt) return {};

    let content: any = {};
    try {
      content = JSON.parse(evt.content || '{}');
    } catch {
      return {};
    }

    if (content.name || content.displayName || content.display_name) {
      return content;
    }

    return {};
  }

  // Bolt Advantage: return the id of the event we signed once any relay accepts
  // it. Upstream asked each relay for the author's latest note right after
  // publishing, which can return an older note and record the wrong id.
  private async publish(pubkey: string, event: any) {
    let accepted = false;
    for (const relay of list) {
      try {
        const relayInstance = await Relay.connect(relay);
        await relayInstance.publish(event);
        relayInstance.close();
        accepted = true;
      } catch (err) {
        /**empty**/
      }
    }

    return accepted ? event.id : '';
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    try {
      const body = JSON.parse(Buffer.from(params.code, 'base64').toString());

      const pubkey = getPublicKey(this.secretKey(body.password));
      // Bolt Advantage: an account with no profile shows its npub, not "No Name"
      const npub = nip19.npubEncode(pubkey);
      const shortNpub = `${npub.slice(0, 12)}…${npub.slice(-6)}`;

      const user = await this.findRelayInformation(pubkey);

      return {
        id: pubkey,
        name: user.display_name || user.displayName || user.name || shortNpub,
        accessToken: AuthService.signJWT({ password: body.password }),
        refreshToken: '',
        expiresIn: dayjs().add(200, 'year').unix() - dayjs().unix(),
        picture: user?.picture || '',
        username: user.name || shortNpub,
      };
    } catch (e) {
      console.log(e);
      return 'Invalid credentials';
    }
  }

  private buildContent(post: PostDetails): string {
    const mediaContent = post.media?.map((m) => m.path).join('\n\n') || '';
    return mediaContent
      ? `${post.message}\n\n${mediaContent}`
      : post.message;
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[]
  ): Promise<PostResponse[]> {
    const { password } = AuthService.verifyJWT(accessToken) as any;
    const [firstPost] = postDetails;

    const textEvent = finalizeEvent(
      {
        kind: 1, // Text note
        content: this.buildContent(firstPost),
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      },
      this.secretKey(password)
    );

    const eventId = await this.publish(id, textEvent);

    return [
      {
        id: firstPost.id,
        postId: String(eventId),
        releaseURL: `https://primal.net/e/${eventId}`,
        status: 'completed',
      },
    ];
  }

  async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const { password } = AuthService.verifyJWT(accessToken) as any;
    const [commentPost] = postDetails;
    const replyToId = lastCommentId || postId;

    const textEvent = finalizeEvent(
      {
        kind: 1, // Text note
        content: this.buildContent(commentPost),
        tags: [
          ['e', replyToId, '', 'reply'],
          ['p', id],
        ],
        created_at: Math.floor(Date.now() / 1000),
      },
      this.secretKey(password)
    );

    const eventId = await this.publish(id, textEvent);

    return [
      {
        id: commentPost.id,
        postId: String(eventId),
        releaseURL: `https://primal.net/e/${eventId}`,
        status: 'completed',
      },
    ];
  }
}

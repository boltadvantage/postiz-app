// Bolt Advantage: Facebook's webhook callback. Public (Facebook can't sign in),
// so every push must carry Facebook's signature made with our app secret.
import { Controller, Get, HttpCode, HttpException, Logger, Post, Query, RawBodyRequest, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InboxService } from '@gitroom/nestjs-libraries/bolt-inbox/inbox.service';
import { parseFeedPush, validSignature, verifyToken } from '@gitroom/nestjs-libraries/bolt-inbox/facebook.webhook';

@ApiTags('Bolt Meta Webhook')
@Controller('/bolt-meta-webhook')
export class BoltMetaWebhookController {
  private readonly _logger = new Logger('BoltMetaWebhook');

  constructor(private _inbox: InboxService) {}

  /** Facebook checks the callback URL once, when it's saved in the app dashboard. */
  @Get('/')
  verify(@Query('hub.mode') mode?: string, @Query('hub.verify_token') token?: string, @Query('hub.challenge') challenge?: string) {
    const want = verifyToken();
    if (mode !== 'subscribe' || !want || token !== want) throw new HttpException('Forbidden', 403);
    return challenge || '';
  }

  @Post('/')
  @HttpCode(200)
  async push(@Req() req: RawBodyRequest<any>) {
    if (!validSignature(req.rawBody, req.headers?.['x-hub-signature-256'], process.env.FACEBOOK_APP_SECRET)) {
      throw new HttpException('Bad signature', 403);
    }
    const comments = parseFeedPush(req.body);
    if (comments.length) {
      // answer Facebook quickly whatever happens here, or it retries and then gives up on us
      await this._inbox.learnFacebookAuthors(comments).catch((err) => this._logger.warn(`learn authors: ${err?.message || err}`));
    }
    return 'ok';
  }
}

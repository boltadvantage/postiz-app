// Bolt Advantage: Canva in the post editor — connect, new design, your
// designs, and bringing a design back as media.
import { Body, Controller, Delete, Get, HttpException, Post, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { Response } from 'express';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { CanvaService } from '@gitroom/nestjs-libraries/bolt-canva/canva.service';
import { canvaReturnUrl } from '@gitroom/nestjs-libraries/bolt-canva/canva';
import { requireOrgAdmin } from '@gitroom/nestjs-libraries/user/require.org.admin';

const wrap = async <T>(fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (e: any) {
    throw new HttpException(e?.message || 'Something went wrong', 400);
  }
};
const pageList = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n)) : undefined);

@ApiTags('Bolt Canva')
@Controller('/bolt-canva')
export class BoltCanvaController {
  constructor(private _canva: CanvaService) {}

  @Get('/status')
  status(@GetOrgFromRequest() org: Organization) {
    return this._canva.status(org.id);
  }

  @Get('/connect')
  connect(@GetOrgFromRequest() org: Organization) {
    requireOrgAdmin(org);
    return wrap(async () => ({ url: await this._canva.connectUrl(org.id) }));
  }

  /** Canva sends the browser here after sign-in; it lands back on the return page. */
  @Get('/callback')
  async callback(
    @GetOrgFromRequest() org: Organization,
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string
  ) {
    const back = new URL(canvaReturnUrl());
    try {
      if (error) throw new Error(error === 'access_denied' ? 'Canva access was declined' : `Canva said: ${error}`);
      if (!code || !state) throw new Error('Canva did not finish signing in');
      await this._canva.finishConnect(org.id, code, state);
      back.searchParams.set('connected', '1');
    } catch (e: any) {
      back.searchParams.set('error', String(e?.message || e).slice(0, 300));
    }
    return res.redirect(back.toString());
  }

  @Delete('/')
  disconnect(@GetOrgFromRequest() org: Organization) {
    requireOrgAdmin(org);
    return this._canva.disconnect(org.id);
  }

  @Post('/designs')
  newDesign(@GetOrgFromRequest() org: Organization, @Body() body: { size?: string; width?: number; height?: number; title?: string }) {
    return wrap(() => this._canva.newDesign(org.id, body || {}));
  }

  @Get('/designs')
  designs(@GetOrgFromRequest() org: Organization, @Query('q') q?: string, @Query('continuation') continuation?: string) {
    return wrap(() => this._canva.designs(org.id, q || undefined, continuation || undefined));
  }

  @Post('/import')
  importDesign(@GetOrgFromRequest() org: Organization, @Body() body: { designId?: string; pages?: number[]; format?: 'jpg' | 'png' }) {
    if (!body?.designId) throw new HttpException('designId is required', 400);
    return wrap(async () => ({ media: await this._canva.importDesign(org.id, String(body.designId), { pages: pageList(body.pages), format: body.format }) }));
  }

  /** The return page hands over Canva's signed return token. */
  @Post('/return')
  finishReturn(@GetOrgFromRequest() org: Organization, @Body() body: { token?: string }) {
    if (!body?.token) throw new HttpException('token is required', 400);
    return wrap(() => this._canva.finishReturn(org.id, String(body.token)));
  }
}

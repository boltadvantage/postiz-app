// Bolt Advantage: "pause all posting". Pausing stops every scheduled post's
// publishing workflow and holds the post; while paused, anything newly
// scheduled is held instead of started. Resuming is done by PostsService
// (it owns rescheduling) using held() / release().
import { Injectable, Logger } from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

@Injectable()
export class PauseService {
  private readonly _logger = new Logger('BoltPause');

  constructor(
    private _prisma: PrismaService,
    private _temporalService: TemporalService
  ) {}

  async isPaused(organizationId: string) {
    const row = await this._prisma.boltPostingPause.findUnique({ where: { organizationId } });
    return !!row?.paused;
  }

  async status(organizationId: string) {
    const [row, held] = await Promise.all([
      this._prisma.boltPostingPause.findUnique({ where: { organizationId } }),
      this._prisma.boltHeldPost.count({ where: { organizationId } }),
    ]);
    return { paused: !!row?.paused, pausedAt: row?.pausedAt || null, held };
  }

  setPaused(organizationId: string, paused: boolean) {
    return this._prisma.boltPostingPause.upsert({
      where: { organizationId },
      create: { organizationId, paused, pausedAt: paused ? new Date() : null },
      update: { paused, pausedAt: paused ? new Date() : null },
    });
  }

  /** Record a post as held (called when a pause stops it, or when it's scheduled while paused). */
  async hold(organizationId: string, postId: string) {
    const post = await this._prisma.post.findUnique({ where: { id: postId }, select: { publishDate: true } });
    if (!post) return;
    await this._prisma.boltHeldPost.upsert({
      where: { postId },
      create: { postId, organizationId, originalDate: post.publishDate },
      update: { originalDate: post.publishDate },
    });
  }

  /** Pause now: flag the organization, then stop every running post workflow and hold its post. */
  async pause(organizationId: string) {
    await this.setPaused(organizationId, true);
    let stopped = 0;
    const client = this._temporalService.client?.getRawClient();
    if (!client) return { stopped };
    const running = client.workflow.list({
      query: `organizationId="${organizationId}" AND ExecutionStatus="Running"`,
    });
    for await (const info of running) {
      if (!info.workflowId.startsWith('post_')) continue;
      const postId = info.workflowId.slice('post_'.length);
      try {
        await client.workflow.getHandle(info.workflowId).terminate('Paused by Bolt "pause all posting"');
        await this.hold(organizationId, postId);
        stopped += 1;
      } catch (err: any) {
        this._logger.warn(`could not stop ${info.workflowId}: ${err?.message || err}`);
      }
    }
    return { stopped };
  }

  held(organizationId: string) {
    return this._prisma.boltHeldPost.findMany({ where: { organizationId }, orderBy: { originalDate: 'asc' } });
  }

  release(postId: string) {
    return this._prisma.boltHeldPost.deleteMany({ where: { postId } });
  }
}

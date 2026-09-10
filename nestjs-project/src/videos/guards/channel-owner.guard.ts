import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtPayload } from '../../auth/auth.types';
import { VideosService } from '../videos.service';

@Injectable()
export class ChannelOwnerGuard implements CanActivate {
  constructor(private readonly videosService: VideosService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user: JwtPayload; params: { id: string } }>();

    await this.videosService.assertOwnership(
      request.params.id,
      request.user.sub,
    );

    return true;
  }
}

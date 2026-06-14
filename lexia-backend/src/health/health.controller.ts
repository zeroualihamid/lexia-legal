import { Controller, Get, Req, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { getSessionFromRequest } from "../common/session";

@ApiTags("Health")
@Controller()
export class HealthController {
  @Get("me")
  @ApiOperation({ summary: "Return the current better-auth session, or 401" })
  async me(@Req() req: Request, @Res() res: Response): Promise<void> {
    const session = await getSessionFromRequest(req);
    res.status(session ? 200 : 401).json(session);
  }
}

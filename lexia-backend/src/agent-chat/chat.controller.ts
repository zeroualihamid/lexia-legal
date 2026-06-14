import { Controller, Post, Req, Res, UseGuards } from "@nestjs/common";
import {
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from "@nestjs/swagger";
import type { Request, Response } from "express";
import * as http from "http";
import * as https from "https";
import { AuthGuard } from "../auth/auth.guard";
import { ChatRequestDto } from "./dto/chat-request.dto";

const AGENT_URL = process.env.LEXIA_AGENT_URL ?? "http://localhost:8000";

@ApiTags("Agent Chat")
@Controller("chat")
export class AgentChatController {
  /**
   * Proxies the agent's Server-Sent-Events chat stream on the unified port.
   * The upstream (sse-starlette) already emits well-formed `event:`/`data:`
   * frames, so we pipe the bytes through unchanged rather than using @Sse()
   * (which would re-frame an RxJS Observable and drop the event names).
   */
  @Post("stream")
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: "Chat with streaming response (SSE)",
    description:
      "Runs the agent flow and streams progress as Server-Sent Events. Requires a valid better-auth session.",
  })
  @ApiHeader({ name: "X-Session-ID", required: false, description: "Chat session id (echoed back in the response)" })
  @ApiBody({ type: ChatRequestDto })
  @ApiProduces("text/event-stream")
  @ApiOkResponse({
    description:
      "SSE stream of `event: <name>\\ndata: <json>\\n\\n` frames. Event names: " +
      "session_created, workflow_start, thinking, tool_start, tool_result, iteration, " +
      "response, workflow_complete, chart_data, error, heartbeat. Response header X-Session-ID " +
      "carries the (possibly newly created) session id.",
  })
  chatStream(@Req() req: Request, @Res() res: Response): void {
    const target = new URL("/chat/stream", AGENT_URL);
    const client = target.protocol === "https:" ? https : http;

    const headers: Record<string, string> = {
      "content-type": String(req.headers["content-type"] ?? "application/json"),
      accept: "text/event-stream",
    };
    if (req.headers["x-session-id"]) {
      headers["x-session-id"] = String(req.headers["x-session-id"]);
    }

    const upstream = client.request(target, { method: "POST", headers }, (upRes) => {
      res.status(upRes.statusCode ?? 200);
      res.setHeader("Content-Type", String(upRes.headers["content-type"] ?? "text/event-stream"));
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      const sid = upRes.headers["x-session-id"];
      if (sid) res.setHeader("X-Session-ID", String(sid));
      res.setHeader("Access-Control-Expose-Headers", "X-Session-ID");
      res.flushHeaders();
      upRes.pipe(res);
    });

    upstream.on("error", (err) => {
      if (!res.headersSent) res.status(502).json({ error: "agent_unreachable" });
      else res.end();
    });

    // Forward the raw request body (no global parser ran -> req is untouched).
    req.pipe(upstream);

    // Tear down the upstream only when the *client response* connection closes
    // (i.e. the browser aborted the fetch). NOTE: do NOT key off req's 'close'
    // — an IncomingMessage emits 'close' as soon as its body is fully read,
    // which would kill the upstream before the SSE response streams back.
    res.on("close", () => {
      if (!upstream.destroyed) upstream.destroy();
    });
  }
}

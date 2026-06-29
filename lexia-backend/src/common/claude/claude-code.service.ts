import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class ClaudeCodeService {
  private readonly logger = new Logger(ClaudeCodeService.name);

  constructor(private readonly config: ConfigService) {}

  isAvailable(): boolean {
    return !!this.config.get<string>('claude.oauthToken');
  }

  /**
   * Run `claude --print` with CLAUDE_CODE_OAUTH_TOKEN and parse JSON from stdout.
   */
  async invokeJson<T = Record<string, unknown>>(
    prompt: string,
    options?: { timeoutMs?: number; label?: string },
  ): Promise<T | null> {
    const oauthToken = this.config.get<string>('claude.oauthToken');
    if (!oauthToken) {
      this.logger.warn('CLAUDE_CODE_OAUTH_TOKEN not configured');
      return null;
    }

    const timeoutMs =
      options?.timeoutMs ??
      this.config.get<number>('claude.classificationTimeoutMs') ??
      90_000;

    const runDir = path.join(os.tmpdir(), 'lexia-claude-code', uuidv4());
    await fs.mkdir(path.join(runDir, '.home'), { recursive: true });
    await fs.mkdir(path.join(runDir, '.claude'), { recursive: true });

    try {
      const raw = await this.runPrint(prompt, oauthToken, runDir, timeoutMs, options?.label);
      return this.extractJson<T>(raw);
    } finally {
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private runPrint(
    prompt: string,
    oauthToken: string,
    cwd: string,
    timeoutMs: number,
    label?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
      env.ANTHROPIC_AUTH_TOKEN = oauthToken;
      env.HOME = path.join(cwd, '.home');
      env.CLAUDE_CONFIG_DIR = path.join(cwd, '.claude');

      const args = [
        '--print',
        '--permission-mode',
        'dontAsk',
        '--tools',
        '',
        '--no-session-persistence',
      ];

      this.logger.debug(
        `claude --print (${label || 'json'}) timeout=${timeoutMs}ms`,
      );

      const child = spawn('claude', args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      const timer = setTimeout(() => {
        try {
          if (child.pid && process.platform !== 'win32') {
            process.kill(-child.pid, 'SIGTERM');
          } else {
            child.kill('SIGTERM');
          }
        } catch {
          /* already exited */
        }
        fail(new Error(`claude timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (err) => fail(new Error(`claude spawn failed: ${err.message}`)));
      child.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
        } else {
          const tail = stderr.trim().split('\n').slice(-3).join(' ');
          fail(new Error(`claude exited ${code}${tail ? `: ${tail}` : ''}`));
        }
      });

      child.stdin.on('error', (err) =>
        fail(new Error(`claude stdin error: ${err.message}`)),
      );
      child.stdin.end(prompt);
    });
  }

  private extractJson<T>(raw: string): T | null {
    const text = (raw || '').trim();
    if (!text) return null;

    const candidates: string[] = [text];
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) candidates.unshift(fenced[1].trim());

    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) candidates.push(objectMatch[0]);

    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate) as T;
      } catch {
        continue;
      }
    }
    return null;
  }
}

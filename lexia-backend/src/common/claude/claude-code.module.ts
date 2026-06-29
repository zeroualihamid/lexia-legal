import { Global, Module } from '@nestjs/common';
import { ClaudeCodeService } from './claude-code.service';

@Global()
@Module({
  providers: [ClaudeCodeService],
  exports: [ClaudeCodeService],
})
export class ClaudeCodeModule {}

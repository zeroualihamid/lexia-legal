import { Module } from '@nestjs/common';
import { AgentDocsClient } from './agent-docs.client';

@Module({
  providers: [AgentDocsClient],
  exports: [AgentDocsClient],
})
export class AgentDocsModule {}

import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { AgentService } from './agent/agent.service';
import { EmbeddingService } from './agent/embedding.service';
import { RagService } from './agent/rag.service';
import { ToolExecutorService } from './agent/tool-executor.service';
import { ChunkingService } from './agent/chunking.service';

@Module({
  controllers: [ChatController],
  providers: [
    ChatService,
    AgentService,
    EmbeddingService,
    RagService,
    ToolExecutorService,
    ChunkingService,
  ],
  exports: [
    EmbeddingService,
    RagService,
    ToolExecutorService,
    ChunkingService,
    AgentService,
    ChatService,
  ],
})
export class ChatModule {}

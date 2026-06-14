import { Injectable, NotFoundException } from '@nestjs/common';
import { PostgresService } from '../../database/postgres.service';

export interface Conversation {
  id: string;
  user_id: string;
  title_ar: string;
  message_count: number;
  is_archived: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  tokens_used: number;
  created_at: Date;
}

@Injectable()
export class ChatService {
  constructor(private postgresService: PostgresService) {}

  async createConversation(userId: string): Promise<Conversation> {
    const result = await this.postgresService.queryOne<Conversation>(
      `INSERT INTO conversations (user_id, title_ar, message_count, is_archived)
       VALUES ($1, 'محادثة جديدة', 0, false)
       RETURNING *`,
      [userId],
    );
    return result;
  }

  async getConversations(userId: string): Promise<Conversation[]> {
    return this.postgresService.query<Conversation>(
      `SELECT * FROM conversations
       WHERE user_id = $1 AND is_archived = false
       ORDER BY updated_at DESC
       LIMIT 50`,
      [userId],
    );
  }

  async getMessages(conversationId: string, userId: string): Promise<Message[]> {
    const conversation = await this.postgresService.queryOne<Conversation>(
      `SELECT * FROM conversations WHERE id = $1 AND user_id = $2`,
      [conversationId, userId],
    );

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    return this.postgresService.query<Message>(
      `SELECT * FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [conversationId],
    );
  }

  async archiveConversation(id: string, userId: string): Promise<void> {
    const result = await this.postgresService.query(
      `UPDATE conversations SET is_archived = true
       WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
  }

  async saveMessage(
    conversationId: string,
    role: string,
    content: string,
    options: { tokensUsed?: number } = {},
  ): Promise<Message> {
    return this.postgresService.queryOne<Message>(
      `INSERT INTO messages (conversation_id, role, content, tokens_used)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [conversationId, role, content, options.tokensUsed || 0],
    );
  }
}

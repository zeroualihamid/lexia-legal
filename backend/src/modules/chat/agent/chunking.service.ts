import { Injectable } from '@nestjs/common';

interface Chunk {
  content: string;
  articleRef?: string;
  chunkIndex: number;
}

@Injectable()
export class ChunkingService {
  private readonly MAX_TOKENS = 500;
  private readonly OVERLAP_TOKENS = 50;
  // Arabic chars ~0.6 tokens each, so max chars ≈ MAX_TOKENS / 0.6
  private readonly MAX_CHARS = Math.floor(this.MAX_TOKENS / 0.6);
  private readonly OVERLAP_CHARS = Math.floor(this.OVERLAP_TOKENS / 0.6);

  chunkDocument(
    text: string,
    collection: string,
  ): Chunk[] {
    if (collection === 'legal_laws') {
      return this.chunkLaws(text);
    } else if (collection.startsWith('judgments')) {
      return this.chunkJudgments(text);
    } else {
      return this.chunkByTokens(text);
    }
  }

  private chunkLaws(text: string): Chunk[] {
    // Split by article/fasil markers
    const articlePattern = /(?=المادة\s+\d+|الفصل\s+\d+)/g;
    const rawChunks = text.split(articlePattern).filter((c) => c.trim().length > 0);

    const chunks: Chunk[] = [];
    let index = 0;

    for (const raw of rawChunks) {
      // If chunk is too large, sub-chunk it
      if (this.estimateTokens(raw) > this.MAX_TOKENS) {
        const subChunks = this.splitByTokens(raw, index);
        const articleRef = this.extractArticleRef(raw);
        for (const sub of subChunks) {
          chunks.push({ ...sub, articleRef: articleRef || sub.articleRef });
        }
        index += subChunks.length;
      } else {
        chunks.push({
          content: raw.trim(),
          articleRef: this.extractArticleRef(raw),
          chunkIndex: index++,
        });
      }
    }

    return chunks.length > 0 ? chunks : this.chunkByTokens(text);
  }

  private chunkJudgments(text: string): Chunk[] {
    const judgmentPattern = /(?=حيث\s+|وحيث\s+|لهذه\s+الأسباب)/g;
    const rawChunks = text.split(judgmentPattern).filter((c) => c.trim().length > 0);

    const chunks: Chunk[] = [];
    let index = 0;

    for (const raw of rawChunks) {
      if (this.estimateTokens(raw) > this.MAX_TOKENS) {
        const subChunks = this.splitByTokens(raw, index);
        chunks.push(...subChunks);
        index += subChunks.length;
      } else {
        chunks.push({
          content: raw.trim(),
          chunkIndex: index++,
        });
      }
    }

    return chunks.length > 0 ? chunks : this.chunkByTokens(text);
  }

  private chunkByTokens(text: string): Chunk[] {
    return this.splitByTokens(text, 0);
  }

  private splitByTokens(text: string, startIndex: number): Chunk[] {
    const chunks: Chunk[] = [];
    let pos = 0;
    let chunkIndex = startIndex;

    while (pos < text.length) {
      const end = Math.min(pos + this.MAX_CHARS, text.length);
      let chunkText = text.slice(pos, end);

      // Try to break at a sentence boundary if not at end
      if (end < text.length) {
        const lastBreak = Math.max(
          chunkText.lastIndexOf('.\n'),
          chunkText.lastIndexOf('،'),
          chunkText.lastIndexOf('\n\n'),
        );
        if (lastBreak > this.MAX_CHARS * 0.5) {
          chunkText = chunkText.slice(0, lastBreak + 1);
        }
      }

      if (chunkText.trim().length > 0) {
        chunks.push({
          content: chunkText.trim(),
          articleRef: this.extractArticleRef(chunkText),
          chunkIndex: chunkIndex++,
        });
      }

      pos += chunkText.length - this.OVERLAP_CHARS;
      if (pos <= 0) pos = chunkText.length; // safety guard
    }

    return chunks;
  }

  private estimateTokens(text: string): number {
    const arabicChars = (text.match(/[؀-ۿ]/g) || []).length;
    const otherChars = text.length - arabicChars;
    return Math.ceil(arabicChars * 0.6 + otherChars * 0.25);
  }

  private extractArticleRef(text: string): string | undefined {
    const match = text.match(/^(المادة\s+\d+|الفصل\s+\d+)/);
    return match ? match[0].trim() : undefined;
  }
}

import { ApiProperty } from "@nestjs/swagger";

/**
 * Documentation-only DTO for POST /chat/stream. The body is streamed verbatim
 * to the agent (not parsed), so this class exists purely for Swagger.
 */
export class ChatRequestDto {
  @ApiProperty({
    description: "Natural-language user query",
    example: "Quels sont les revenus 2024 ?",
    minLength: 1,
    maxLength: 2000,
  })
  query!: string;
}

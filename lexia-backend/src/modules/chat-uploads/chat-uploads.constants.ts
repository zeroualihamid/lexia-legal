/**
 * Synthetic case id used to tag a chat-uploaded (non-judgment) document in the
 * agent's FastEmbed index while it is not yet linked to a real case. The
 * general-chat retrieval filters by owner only, so this value never affects
 * recall; linking to a case re-indexes the document under the real case id.
 */
export const CHAT_UPLOAD_INBOX_CASE = '__chat_inbox__';

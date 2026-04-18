// Minimal Telegram Bot API response shapes. Only the fields relay actually
// reads are modeled — the full schema is intentionally out of scope.
//
// Reference: https://core.telegram.org/bots/api

// A Telegram user. We only consume `id` and a couple of optional display fields
// for potential logging. Other fields (is_bot, language_code, etc.) are ignored.
export interface TgUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

// A chat object — we only look at `id` on inbound messages to resolve the
// group-side half of a destination key.
export interface TgChat {
  id: number;
  type?: string;
}

// A message inside a forum-topic-enabled chat. `message_thread_id` is present
// for any message (including the system events) that sits inside a topic;
// relay uses it as the topic half of the destination key.
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  message_thread_id?: number;
  reply_to_message?: TgMessage;
  // System events inside a forum topic. Their presence lets `receive` skip
  // non-user-originated messages without needing to introspect further.
  forum_topic_created?: unknown;
  forum_topic_closed?: unknown;
  forum_topic_reopened?: unknown;
  forum_topic_edited?: unknown;
  is_topic_message?: boolean;
}

// A single entry from `getUpdates`. We only consume `message` updates; other
// update kinds (edited_message, channel_post, callback_query, …) are filtered
// out by `allowed_updates` on the request side.
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

// Returned by `createForumTopic`. We only need the thread id.
export interface TgForumTopic {
  message_thread_id: number;
  name?: string;
  icon_color?: number;
}

// Generic Bot API response envelope. Bot API always returns `{ ok, result? }`
// or `{ ok: false, error_code, description, parameters? }`.
export interface TgApiOk<T> {
  ok: true;
  result: T;
}

export interface TgApiErr {
  ok: false;
  error_code: number;
  description: string;
  parameters?: {
    retry_after?: number;
    migrate_to_chat_id?: number;
  };
}

export type TgApiResponse<T> = TgApiOk<T> | TgApiErr;

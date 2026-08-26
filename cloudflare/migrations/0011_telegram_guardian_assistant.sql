PRAGMA foreign_keys = ON;

CREATE TABLE telegram_updates (
  owner_id TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('RECEIVED','PROCESSING','ANSWERED','FAILED')),
  question_hash TEXT NOT NULL,
  answer_hash TEXT,
  error_code TEXT,
  received_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY(owner_id, update_id)
);

CREATE INDEX telegram_updates_owner_time ON telegram_updates(owner_id, received_at DESC);

CREATE TABLE telegram_conversation_messages (
  owner_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, message_id)
);

CREATE INDEX telegram_messages_thread_time
  ON telegram_conversation_messages(owner_id, chat_id, created_at DESC);

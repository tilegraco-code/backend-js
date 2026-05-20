export type UnipileState = 'ia' | 'human';
export type UnipileChatStatus = 'open' | 'resolved';
export type UnipileInboxStatus = 'pending' | 'inactive' | 'active';
export type UnipileAccountStatus = 'connected' | 'disconnected' | 'error' | 'connecting';

export type UnipileSender = {
  attendee_id: string;
  attendee_name: string;
  attendee_provider_id: string;
  attendee_profile_url: string | null;
};

export type UnipileWebhookPayload = {
  event: string;
  account_id: string;
  account_type: string;
  account_info?: {
    user_id?: string | null;
    feature?: string | null;
  } | null;
  chat_id: string;
  message_id: string;
  message: string;
  timestamp: string;
  webhook_name?: string;
  is_sender?: boolean;
  sender: UnipileSender;
  attendees?: UnipileSender[];
  attachments?: { type: string; mimetype: string; url: string }[];
};

export type UnipileAccountStatusPayload = {
  AccountStatus: {
    account_id: string;
    message: string;
    account_type?: string;
    error?: string;
  };
};

export type UnipileCredentials = {
  api_key: string;
  dsn: string;
};

export type UnipileInbox = {
  id: number;
  client_id: number;
  account_id: string | null;
  workflow_id: number | null;
  provider: string | null;
  display_name: string | null;
  status: UnipileInboxStatus;
  account_status: UnipileAccountStatus;
  connection_token: string | null;
  created_at: string;
  updated_at: string;
};

export type UnipileChat = {
  id: number;
  client_id: number;
  chat_id: string;
  account_id: string;
  workflow_id: number | null;
  state: UnipileState;
  status: UnipileChatStatus;
  provider: string | null;
  contact_name: string | null;
  contact_id: string | null;
  contact_handle: string | null;
  contact_avatar_url: string | null;
  unread_count: number;
  last_message_preview: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
};

export type UnipileMessage = {
  id: number;
  chat_id: string;
  client_id: number;
  message_id: string;
  content: string;
  direction: 'incoming' | 'outgoing';
  sender_name: string | null;
  created_at: string;
};

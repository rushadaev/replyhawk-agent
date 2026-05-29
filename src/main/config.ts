// ReplyHawk cloud endpoint. Override at build time with REPLYHAWK_API_URL.
export const API_URL =
  process.env.REPLYHAWK_API_URL ?? 'https://lead-bot-next-production.up.railway.app';

// Keychain identifiers
export const KEYCHAIN_SERVICE = 'com.replyhawk.agent';
export const KEYCHAIN_ACCOUNT = 'agent_token';

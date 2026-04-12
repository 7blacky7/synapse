// Re-Export aus @synapse/core (Backward-Compat)
// Logik wurde nach core verschoben — siehe packages/core/src/services/inbox.ts
export {
  postToInbox,
  checkInbox,
  getNewInboxMessages as getNewMessages,
  getInboxHistory,
} from '@synapse/core'
export type { InboxMessage } from '@synapse/core'

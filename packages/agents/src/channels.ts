// Re-Export aus @synapse/core (Backward-Compat)
// Logik wurde nach core verschoben — siehe packages/core/src/services/channels.ts
export {
  createChannel,
  deleteChannel,
  joinChannel,
  leaveChannel,
  postChannelMessage as postMessage,
  getChannelMessages as getMessages,
  getChannelMembers,
  listChannels,
  getNewMessagesForAgent,
  ensureGeneralChannel,
  removeAgentFromAllChannels,
  unregisterChatAgent as unregisterAgent,
} from '@synapse/core'
export type { ChannelMessage } from '@synapse/core'

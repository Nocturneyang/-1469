'use strict';

async function readWhatsAppChatSnapshot(client) {
  try {
    const chats = await client.getChats();
    return {
      chats,
      groups: (chats || []).map(toWhatsAppGroup).filter((group) => group.group_id),
      degraded: false,
      failedCount: 0,
      failures: [],
      originalError: null,
    };
  } catch (originalError) {
    if (!client?.pupPage || typeof client.pupPage.evaluate !== 'function') throw originalError;
    const fallback = await client.pupPage.evaluate(async () => {
      const collection = window.require('WAWebCollections').Chat;
      const sourceChats = collection?.getModelsArray?.() || [];
      const entries = await Promise.all(sourceChats.map(async (chat) => {
        try {
          return { model: await window.WWebJS.getChatModel(chat), error: '' };
        } catch (err) {
          const serializedId = String(
            chat?.id?._serialized || chat?.id?.toString?.() || chat?.id || '',
          );
          return {
            model: {
              id: {
                _serialized: serializedId,
                user: chat?.id?.user,
                server: chat?.id?.server,
              },
              formattedTitle: chat?.formattedTitle || chat?.name || serializedId,
              isGroup: Boolean(chat?.groupMetadata),
              unreadCount: Number(chat?.unreadCount || 0),
              pin: chat?.pin || 0,
            },
            error: String(err?.message || err || 'unknown chat model error'),
          };
        }
      }));
      return {
        models: entries.map((entry) => entry.model).filter(Boolean),
        failedCount: entries.filter((entry) => entry.error).length,
        failures: entries
          .filter((entry) => entry.error)
          .slice(0, 20)
          .map((entry) => ({
            chat_id: entry.model?.id?._serialized || '',
            error: entry.error,
          })),
      };
    });
    const models = Array.isArray(fallback?.models) ? fallback.models : [];
    return {
      chats: [],
      groups: models.map(toWhatsAppGroup).filter((group) => group.group_id),
      degraded: true,
      failedCount: Number(fallback?.failedCount || 0),
      failures: Array.isArray(fallback?.failures) ? fallback.failures : [],
      originalError,
    };
  }
}

function toWhatsAppGroup(chat) {
  const groupId = whatsappChatId(chat?.id) || String(chat?.group_id || '').trim();
  return {
    group_id: groupId,
    group_name: String(
      chat?.name || chat?.formattedTitle || chat?.group_name || groupId || '未命名会话',
    ),
    kind: chat?.isGroup ? 'group' : 'chat',
    raw_json: {
      id: chat?.id || groupId,
      isGroup: Boolean(chat?.isGroup),
      unreadCount: Number(chat?.unreadCount || 0),
      pinned: Boolean(chat?.pinned || chat?.pin),
    },
  };
}

function whatsappChatId(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (value._serialized) return String(value._serialized).trim();
  if (value.user && value.server) return `${value.user}@${value.server}`;
  if (value.user) return String(value.user).trim();
  return '';
}

module.exports = {
  readWhatsAppChatSnapshot,
  toWhatsAppGroup,
  whatsappChatId,
};

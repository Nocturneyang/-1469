'use strict';

async function readWhatsAppChatSnapshot(client) {
  const nativeSnapshot = await readNativeWhatsAppChatSnapshot(client);
  if (nativeSnapshot?.available) {
    const models = Array.isArray(nativeSnapshot.models) ? nativeSnapshot.models : [];
    return {
      chats: [],
      groups: models.map(toWhatsAppGroup).filter((group) => group.group_id),
      labelSnapshot: nativeSnapshot.labelSnapshot,
      snapshotMode: 'native',
      degraded: false,
      failedCount: 0,
      failures: [],
      originalError: null,
    };
  }

  try {
    const chats = await client.getChats();
    return {
      chats,
      groups: (chats || []).map(toWhatsAppGroup).filter((group) => group.group_id),
      labelSnapshot: null,
      snapshotMode: 'wwebjs',
      degraded: false,
      failedCount: 0,
      failures: [],
      originalError: null,
    };
  } catch (originalError) {
    if (!client?.pupPage || typeof client.pupPage.evaluate !== 'function') throw originalError;
    const fallback = await readNativeWhatsAppChatSnapshot(client);
    if (!fallback?.available) throw originalError;
    const models = Array.isArray(fallback?.models) ? fallback.models : [];
    return {
      chats: [],
      groups: models.map(toWhatsAppGroup).filter((group) => group.group_id),
      labelSnapshot: fallback.labelSnapshot,
      snapshotMode: 'native-fallback',
      degraded: true,
      failedCount: 0,
      failures: [],
      originalError,
    };
  }
}

async function readNativeWhatsAppChatSnapshot(client) {
  if (!client?.pupPage || typeof client.pupPage.evaluate !== 'function') return null;
  try {
    return await client.pupPage.evaluate(() => {
      const collections = window.require('WAWebCollections');
      const chatCollection = collections?.Chat;
      if (!chatCollection?.getModelsArray) return { available: false };

      const sourceChats = chatCollection.getModelsArray();
      const chatId = (chat) => {
        const id = chat?.id;
        return String(id?._serialized || id?.toString?.() || id || '').trim();
      };
      const models = sourceChats.map((chat) => {
        const id = chat?.id || {};
        const serializedId = chatId(chat);
        return {
          id: {
            _serialized: serializedId,
            user: id?.user,
            server: id?.server,
          },
          formattedTitle: chat?.formattedTitle || chat?.name || serializedId,
          isGroup: Boolean(chat?.groupMetadata),
          unreadCount: Number(chat?.unreadCount || 0),
          pin: chat?.pin || 0,
        };
      });

      const labelCollection = collections?.Label;
      if (!labelCollection?.getModelsArray) return { available: true, models, labelSnapshot: null };
      const labels = labelCollection.getModelsArray().map((label) => {
        const id = String(label?.id?._serialized || label?.id || '').trim();
        return {
          native_label_id: id,
          name: String(label?.name || label?.title || id).trim(),
          color: label?.color || label?.hexColor || null,
          kind: 'label',
          raw_json: { id, name: label?.name || label?.title || id, color: label?.color || label?.hexColor || null },
        };
      }).filter((label) => label.native_label_id);
      const knownLabelIds = new Set(labels.map((label) => label.native_label_id));
      const maps = [];
      sourceChats.forEach((chat) => {
        const groupId = chatId(chat);
        if (!groupId) return;
        (Array.isArray(chat?.labels) ? chat.labels : []).forEach((value) => {
          const nativeLabelId = String(value?.id?._serialized || value?.id || value?.labelId || value || '').trim();
          if (knownLabelIds.has(nativeLabelId)) maps.push({ group_id: groupId, native_label_id: nativeLabelId });
        });
      });
      return { available: true, models, labelSnapshot: { labels, maps } };
    });
  } catch (_) {
    return null;
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
  readNativeWhatsAppChatSnapshot,
  toWhatsAppGroup,
  whatsappChatId,
};

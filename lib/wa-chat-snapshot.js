'use strict';

async function readWhatsAppChatSnapshot(client, options = {}) {
  const excludedNames = Array.isArray(options.excludedNames) ? options.excludedNames : [];
  const nativeSnapshot = await readNativeWhatsAppChatSnapshot(client);
  if (nativeSnapshot?.available) {
    const models = Array.isArray(nativeSnapshot.models) ? nativeSnapshot.models : [];
    return {
      chats: [],
      groups: models.map((chat) => toWhatsAppGroup(chat, { excludedNames })).filter((group) => group.group_id),
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
      groups: (chats || []).map((chat) => toWhatsAppGroup(chat, { excludedNames })).filter((group) => group.group_id),
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
      groups: models.map((chat) => toWhatsAppGroup(chat, { excludedNames })).filter((group) => group.group_id),
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
      const normalizedText = (value) => {
        if (typeof value !== 'string' && typeof value !== 'number') return '';
        return String(value).trim();
      };
      const isInternalId = (value) => /^[^@\s]+@(lid|g\.us|c\.us|s\.whatsapp\.net|broadcast|newsletter)$/i
        .test(normalizedText(value));
      const isPhoneDisplay = (value) => {
        const text = normalizedText(value);
        if (!/^\+?[\d\s().-]{7,}$/.test(text)) return false;
        const digits = text.replace(/\D/g, '');
        return digits.length >= 7 && digits.length <= 18;
      };
      const contactId = (contact) => chatId(contact) || chatId({ id: contact?.phoneNumber });
      const contactAliases = (contact) => {
        if (!contact) return [];
        return [...new Set([
          contactId(contact),
          chatId({ id: contact?.id }),
          chatId({ id: contact?.wid }),
          chatId({ id: contact?.lid }),
          chatId({ id: contact?.lidId }),
          chatId({ id: contact?.phoneNumber }),
          chatId({ id: contact?.pn }),
        ].filter(Boolean))];
      };
      const alternateContactId = (serializedId) => {
        if (!serializedId.endsWith('@lid')) return '';
        try {
          const wid = window.require('WAWebWidFactory')?.createWid?.(serializedId);
          const contactApi = window.require('WAWebApiContact');
          return chatId({ id: contactApi?.getPhoneNumber?.(wid) || contactApi?.getAlternateUserWid?.(wid) });
        } catch (_) {
          return '';
        }
      };
      let contacts = [];
      try {
        contacts = collections?.Contact?.getModelsArray?.() || [];
      } catch (_) { }
      const findContact = (chat, serializedId) => {
        const alternateId = alternateContactId(serializedId);
        const direct = [chat?.id, serializedId, alternateId].filter(Boolean).map((id) => {
          try {
            return collections?.Contact?.get?.(id);
          } catch (_) {
            return null;
          }
        }).find(Boolean);
        if (direct) return direct;
        return contacts.find((contact) => {
          const aliases = contactAliases(contact);
          return aliases.includes(serializedId) || (alternateId && aliases.includes(alternateId));
        }) || null;
      };
      const contactDetails = (contact) => {
        if (!contact) return { name: '', phoneNumber: '' };
        let getters = null;
        try {
          getters = window.require('WAWebContactGetters');
        } catch (_) { }
        const get = (method) => {
          try {
            return normalizedText(getters?.[method]?.(contact));
          } catch (_) {
            return '';
          }
        };
        const names = [
          contact?.name,
          get('getName'),
          contact?.pushname,
          get('getPushname'),
          contact?.shortName,
          get('getShortName'),
          contact?.verifiedName,
          get('getVerifiedName'),
        ].map(normalizedText).filter((value) => value && !isInternalId(value));
        const phoneId = chatId({ id: contact?.phoneNumber });
        const phoneNumber = normalizedText(contact?.number)
          || normalizedText(contact?.userid)
          || normalizedText(contact?.phoneNumber?.user)
          || normalizedText(phoneId).split('@')[0];
        return { name: names[0] || '', phoneNumber };
      };
      const models = sourceChats.map((chat) => {
        const id = chat?.id || {};
        const serializedId = chatId(chat);
        const contact = findContact(chat, serializedId);
        const details = contactDetails(contact);
        let storedGroupMetadata = null;
        try {
          storedGroupMetadata = collections?.GroupMetadata?.get?.(chat?.id)
            || collections?.GroupMetadata?.get?.(serializedId)
            || null;
        } catch (_) { }
        const groupMetadata = chat?.groupMetadata || storedGroupMetadata;
        const isGroup = Boolean(groupMetadata || id?.server === 'g.us' || serializedId.endsWith('@g.us'));
        const groupTitleCandidates = [
          groupMetadata?.subject,
          groupMetadata?.name,
          groupMetadata?.title,
          chat?.subject,
        ].map(normalizedText);
        const directTitleCandidates = [
          chat?.formattedTitle,
          chat?.name,
          details.name,
          details.phoneNumber,
        ].map(normalizedText);
        const titleCandidates = isGroup
          ? [...groupTitleCandidates, ...directTitleCandidates]
          : directTitleCandidates;
        const formattedTitle = titleCandidates.find((value) => value && !isInternalId(value) && !isPhoneDisplay(value))
          || titleCandidates.find((value) => value && !isInternalId(value))
          || serializedId;
        const participants = isGroup ? (Array.isArray(groupMetadata?.participants) ? groupMetadata.participants : [])
          .map((participant) => {
            const participantId = chatId({ id: participant?.id || participant });
            if (!participantId) return null;
            const participantContact = findContact({ id: participant?.id || participant }, participantId);
            const participantDetails = contactDetails(participantContact);
            return {
              id: participantId,
              name: participantDetails.name || participantDetails.phoneNumber || participantId,
              phone_number: participantDetails.phoneNumber || '',
              is_admin: Boolean(participant?.isAdmin || participant?.admin),
              is_super_admin: Boolean(participant?.isSuperAdmin || participant?.superAdmin),
            };
          }).filter(Boolean).slice(0, 1024) : [];
        return {
          id: {
            _serialized: serializedId,
            user: id?.user,
            server: id?.server,
          },
          groupTitle: groupTitleCandidates.find((value) => value && !isInternalId(value)) || '',
          formattedTitle,
          contactName: details.name,
          phoneNumber: details.phoneNumber,
          lidId: chatId({ id: contact?.lid || contact?.lidId }) || (serializedId.endsWith('@lid') ? serializedId : ''),
          phoneId: chatId({ id: contact?.wid || contact?.phoneNumber || contact?.pn }) || alternateContactId(serializedId),
          isGroup,
          unreadCount: Number(chat?.unreadCount || 0),
          pin: chat?.pin || 0,
          archived: Boolean(chat?.archive || chat?.archived || chat?.isArchived),
          groupDescription: normalizedText(groupMetadata?.desc || groupMetadata?.description),
          participants,
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

function toWhatsAppGroup(chat, options = {}) {
  const groupId = whatsappChatId(chat?.id) || String(chat?.group_id || '').trim();
  const sourceParticipants = Array.isArray(chat?.participants)
    ? chat.participants
    : (Array.isArray(chat?.groupMetadata?.participants) ? chat.groupMetadata.participants : []);
  const participants = sourceParticipants.map((participant) => {
    const id = whatsappChatId(participant?.id || participant);
    if (!id) return null;
    return {
      id,
      name: String(participant?.name || participant?.contact?.name || participant?.contact?.pushname || id).trim(),
      phone_number: String(participant?.phoneNumber || participant?.contact?.number || '').trim(),
      is_admin: Boolean(participant?.isAdmin || participant?.admin),
      is_super_admin: Boolean(participant?.isSuperAdmin || participant?.superAdmin),
    };
  }).filter(Boolean).slice(0, 1024);
  return {
    group_id: groupId,
    group_name: whatsappDisplayName(chat, null, groupId, options),
    kind: chat?.isGroup ? 'group' : 'chat',
    raw_json: {
      id: chat?.id || groupId,
      isGroup: Boolean(chat?.isGroup),
      unreadCount: Number(chat?.unreadCount || 0),
      pinned: Boolean(chat?.pinned || chat?.pin),
      archived: Boolean(chat?.archive || chat?.archived || chat?.isArchived),
      contactName: chat?.contactName || null,
      phoneNumber: chat?.phoneNumber || null,
      lidId: chat?.lidId || null,
      phoneId: chat?.phoneId || null,
      groupDescription: chat?.groupDescription || chat?.groupMetadata?.desc || chat?.groupMetadata?.description || null,
      participants,
    },
  };
}

function whatsappDisplayName(chat, contact, fallbackId = '', options = {}) {
  const groupId = whatsappChatId(chat?.id)
    || String(chat?.group_id || fallbackId || '').trim();
  const isGroup = Boolean(chat?.isGroup || chat?.groupMetadata || groupId.endsWith('@g.us'));
  const groupCandidates = [
    chat?.groupTitle,
    chat?.groupMetadata?.subject,
    chat?.groupMetadata?.name,
    chat?.groupMetadata?.title,
    chat?.subject,
    chat?.name,
    chat?.formattedTitle,
    chat?.group_name,
  ];
  const directCandidates = [
    chat?.name,
    chat?.formattedTitle,
    chat?.group_name,
    chat?.contactName,
    contact?.name,
    contact?.pushname,
    contact?.shortName,
    contact?.verifiedName,
    chat?.phoneNumber,
    contact?.number,
    contact?.userid,
  ];
  const excludedNames = new Set((options.excludedNames || [])
    .map(normalizeDisplayText)
    .filter(Boolean)
    .map((value) => value.toLocaleLowerCase()));
  const candidates = (isGroup ? groupCandidates : directCandidates)
    .map(normalizeDisplayText)
    .filter((value) => value && !excludedNames.has(value.toLocaleLowerCase()));
  return candidates.find((value) => !isWhatsAppInternalId(value) && !isWhatsAppPhoneDisplay(value))
    || candidates.find((value) => !isWhatsAppInternalId(value))
    || groupId
    || '未命名会话';
}

function normalizeDisplayText(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim();
}

function isWhatsAppInternalId(value) {
  return /^[^@\s]+@(lid|g\.us|c\.us|s\.whatsapp\.net|broadcast|newsletter)$/i
    .test(normalizeDisplayText(value));
}

function isWhatsAppPhoneDisplay(value) {
  const text = normalizeDisplayText(value);
  if (!/^\+?[\d\s().-]{7,}$/.test(text)) return false;
  const digits = text.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 18;
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
  whatsappDisplayName,
  isWhatsAppInternalId,
  isWhatsAppPhoneDisplay,
  whatsappChatId,
};

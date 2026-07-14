'use strict';

function telegramEntityName(entity, fallback = '') {
  if (!entity) return String(fallback || '').trim();
  const title = cleanText(entity.title);
  if (title) return title;
  const personName = [entity.firstName ?? entity.first_name, entity.lastName ?? entity.last_name]
    .map(cleanText)
    .filter(Boolean)
    .join(' ');
  if (personName) return personName;
  const username = cleanText(entity.username);
  if (username) return `@${username.replace(/^@/, '')}`;
  return String(fallback || '').trim();
}

function telegramEntityUsername(entity) {
  return cleanText(entity?.username).replace(/^@/, '');
}

function telegramUserMediaDescriptor(message) {
  const media = message?.media;
  if (!media) return null;
  const className = String(media.className || media.constructor?.name || '');
  const messageId = cleanText(message.id) || String(Date.now());

  if (className === 'MessageMediaPhoto' || media.photo) {
    return {
      kind: 'image',
      media_kind: 'photo',
      name: `tg-${messageId}.jpg`,
      mime: 'image/jpeg',
      size: safeNumber(media.photo?.sizes?.at?.(-1)?.size),
      downloadable: true,
      label: '图片',
    };
  }

  const document = media.document;
  if (className === 'MessageMediaDocument' || document) {
    const attributes = Array.isArray(document?.attributes) ? document.attributes : [];
    const filenameAttribute = attributes.find((item) => item?.fileName || item?.file_name);
    const stickerAttribute = attributes.find((item) => String(item?.className || item?.constructor?.name || '') === 'DocumentAttributeSticker');
    const audioAttribute = attributes.find((item) => String(item?.className || item?.constructor?.name || '') === 'DocumentAttributeAudio');
    const videoAttribute = attributes.find((item) => String(item?.className || item?.constructor?.name || '') === 'DocumentAttributeVideo');
    const mime = cleanText(document?.mimeType ?? document?.mime_type) || 'application/octet-stream';
    const sticker = Boolean(stickerAttribute);
    const voice = Boolean(media.voice || audioAttribute?.voice);
    const video = Boolean(media.video || videoAttribute);
    const kind = sticker ? 'sticker' : (mime.startsWith('image/') ? 'image' : 'file');
    const extension = mimeExtension(mime, sticker ? 'webp' : 'bin');
    const name = cleanText(filenameAttribute?.fileName ?? filenameAttribute?.file_name) ||
      `tg-${messageId}.${extension}`;
    return {
      kind,
      media_kind: sticker ? 'sticker' : (voice ? 'voice' : (video ? 'video' : (mime.startsWith('image/') ? 'image' : 'document'))),
      name,
      mime,
      size: safeNumber(document?.size),
      downloadable: true,
      label: sticker ? `贴纸${cleanText(stickerAttribute?.alt) ? ` ${cleanText(stickerAttribute.alt)}` : ''}` : (voice ? '语音' : (video ? '视频' : '文件')),
      duration: safeNumber(audioAttribute?.duration ?? videoAttribute?.duration),
    };
  }

  if (className === 'MessageMediaContact' || media.phoneNumber || media.phone_number) {
    const name = [media.firstName ?? media.first_name, media.lastName ?? media.last_name].map(cleanText).filter(Boolean).join(' ');
    return { kind: 'contact', media_kind: 'contact', name: name || '联系人', mime: 'text/vcard', downloadable: false, label: `联系人${name ? `：${name}` : ''}`, detail: cleanText(media.phoneNumber ?? media.phone_number) };
  }
  if (className === 'MessageMediaGeo' || media.geo) {
    const lat = media.geo?.lat ?? media.geo?.latitude;
    const long = media.geo?.long ?? media.geo?.longitude;
    return { kind: 'location', media_kind: 'location', name: '位置', mime: 'application/geo+json', downloadable: false, label: '位置', detail: lat !== undefined && long !== undefined ? `${lat}, ${long}` : '' };
  }
  if (className === 'MessageMediaPoll' || media.poll) {
    const question = media.poll?.question?.text ?? media.poll?.question;
    return { kind: 'poll', media_kind: 'poll', name: '投票', mime: 'application/json', downloadable: false, label: `投票${cleanText(question) ? `：${cleanText(question)}` : ''}` };
  }
  if (className === 'MessageMediaWebPage' || media.webpage) {
    const webpage = media.webpage || {};
    const title = cleanText(webpage.title || webpage.siteName || webpage.site_name);
    const url = cleanText(webpage.url || webpage.displayUrl || webpage.display_url);
    return { kind: 'link', media_kind: 'webpage', name: title || url || '网页链接', mime: 'text/uri-list', downloadable: false, label: title || '网页链接', detail: url };
  }

  return { kind: 'file', media_kind: className || 'unknown', name: '媒体消息', mime: 'application/octet-stream', downloadable: false, label: '媒体消息' };
}

function telegramMessageText(message, descriptor = telegramUserMediaDescriptor(message)) {
  const text = cleanText(message?.message);
  if (text) return text;
  if (!descriptor) return '';
  return [descriptor.label, descriptor.detail].filter(Boolean).join(' · ');
}

function telegramMessageMetadata(message, { chat, sender, descriptor = telegramUserMediaDescriptor(message) } = {}) {
  const forward = message?.fwdFrom || message?.fwd_from;
  const reply = message?.replyTo || message?.reply_to;
  return {
    id: cleanText(message?.id),
    chat_id: telegramPeerId(message?.chatId || message?.peerId || message?.inputChat),
    sender_id: telegramPeerId(message?.senderId || message?.fromId),
    chat_name: telegramEntityName(chat),
    sender_name: cleanText(message?.postAuthor) || telegramEntityName(sender),
    sender_username: telegramEntityUsername(sender),
    out: Boolean(message?.out),
    direction: message?.out ? 'outbound' : 'inbound',
    reply_to_msg_id: safeNumber(reply?.replyToMsgId ?? reply?.reply_to_msg_id),
    quote_text: cleanText(reply?.quoteText ?? reply?.quote_text),
    forwarded_from: cleanText(forward?.fromName ?? forward?.from_name ?? forward?.postAuthor ?? forward?.post_author) || telegramPeerId(forward?.fromId ?? forward?.from_id),
    forwarded_at: timestampIso(forward?.date),
    edited_at: timestampIso(message?.editDate ?? message?.edit_date),
    views: safeNumber(message?.views),
    forwards: safeNumber(message?.forwards),
    grouped_id: cleanText(message?.groupedId ?? message?.grouped_id),
    post_author: cleanText(message?.postAuthor ?? message?.post_author),
    media: descriptor ? {
      kind: descriptor.media_kind,
      name: descriptor.name,
      mime: descriptor.mime,
      size: descriptor.size || null,
      duration: descriptor.duration || null,
      detail: descriptor.detail || '',
    } : null,
  };
}

function telegramPeerId(value) {
  if (value === undefined || value === null) return '';
  const peer = value.peer || value;
  for (const key of ['channelId', 'chatId', 'userId', 'id']) {
    if (peer[key] !== undefined && peer[key] !== null) return cleanText(peer[key]);
  }
  if (typeof peer === 'object' && peer.value !== undefined) return cleanText(peer.value);
  return cleanText(peer);
}

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return '';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

function imageExtensionForMime(mime) {
  return ({
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
  })[String(mime || '').toLowerCase()] || '';
}

function cleanText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object' && typeof value.text === 'string') return value.text.trim();
  if (typeof value === 'object' && value.toString === Object.prototype.toString) return '';
  const text = String(value).trim();
  return text === '[object Object]' ? '' : text;
}

function safeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function timestampIso(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '';
  return new Date(numeric > 1000000000000 ? numeric : numeric * 1000).toISOString();
}

function mimeExtension(mime, fallback) {
  const map = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'application/pdf': 'pdf',
  };
  return map[String(mime || '').toLowerCase()] || fallback;
}

module.exports = {
  detectImageMime,
  imageExtensionForMime,
  telegramEntityName,
  telegramMessageMetadata,
  telegramMessageText,
  telegramPeerId,
  telegramUserMediaDescriptor,
};

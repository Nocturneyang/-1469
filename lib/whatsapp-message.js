'use strict';

function whatsappMediaDescriptor(message) {
  const type = cleanText(message?.type).toLowerCase();
  const data = message?._data || {};
  const messageId = cleanText(message?.id?.id || message?.id?._serialized || message?.id) || String(Date.now());
  const mime = cleanText(message?.mimetype || data.mimetype || data.mimeType) || defaultMime(type);
  const suppliedName = cleanText(message?.filename || data.filename || data.fileName || data.displayName);
  const size = safeNumber(message?.size ?? data.size ?? data.fileSize ?? data.filesize);
  const duration = safeNumber(message?.duration ?? data.duration ?? data.seconds);

  const definitions = {
    image: { kind: 'image', mediaKind: 'image', label: '图片', extension: mimeExtension(mime, 'jpg') },
    video: { kind: 'file', mediaKind: 'video', label: '视频', extension: mimeExtension(mime, 'mp4') },
    audio: { kind: 'file', mediaKind: 'audio', label: '音频', extension: mimeExtension(mime, 'ogg') },
    ptt: { kind: 'file', mediaKind: 'voice', label: '语音', extension: mimeExtension(mime, 'ogg') },
    document: { kind: 'file', mediaKind: 'document', label: '文件', extension: mimeExtension(mime, 'bin') },
    sticker: { kind: 'sticker', mediaKind: 'sticker', label: '贴纸', extension: mimeExtension(mime, 'webp') },
  };
  const definition = definitions[type];
  if (definition || message?.hasMedia) {
    const selected = definition || { kind: 'file', mediaKind: type || 'media', label: '媒体消息', extension: mimeExtension(mime, 'bin') };
    return {
      kind: selected.kind,
      media_kind: selected.mediaKind,
      name: suppliedName || `wa-${safeMessageId(messageId)}.${selected.extension}`,
      mime,
      size,
      duration,
      downloadable: Boolean(message?.hasMedia && typeof message?.downloadMedia === 'function'),
      label: selected.label,
      detail: '',
    };
  }

  if (type === 'location') {
    const location = message?.location || data.location || {};
    const latitude = location.latitude ?? location.lat;
    const longitude = location.longitude ?? location.lng ?? location.long;
    const detail = latitude !== undefined && longitude !== undefined ? `${latitude}, ${longitude}` : '';
    return { kind: 'file', media_kind: 'location', name: '位置', mime: 'application/geo+json', size: null, duration: null, downloadable: false, label: '位置', detail };
  }
  if (type === 'vcard' || type === 'multi_vcard') {
    const name = cleanText(data.displayName || data.notifyName) || '联系人';
    return { kind: 'file', media_kind: 'contact', name, mime: 'text/vcard', size: null, duration: null, downloadable: false, label: `联系人：${name}`, detail: '' };
  }
  return null;
}

function whatsappMessageText(message, descriptor = whatsappMediaDescriptor(message)) {
  const text = cleanText(message?.body || message?._data?.caption);
  if (text) return text;
  if (!descriptor) return '';
  return [descriptor.label, descriptor.detail].filter(Boolean).join(' · ');
}

function whatsappMessageMetadata(message, descriptor = whatsappMediaDescriptor(message)) {
  return {
    platform: 'wa',
    id: message?.id || null,
    from: cleanText(message?.from),
    to: cleanText(message?.to),
    author: cleanText(message?.author),
    fromMe: Boolean(message?.fromMe),
    type: cleanText(message?.type),
    timestamp: safeNumber(message?.timestamp),
    hasMedia: Boolean(message?.hasMedia || descriptor),
    direction: message?.fromMe ? 'outbound' : 'inbound',
    media: descriptor ? {
      kind: descriptor.media_kind,
      name: descriptor.name,
      mime: descriptor.mime,
      size: descriptor.size,
      duration: descriptor.duration,
      detail: descriptor.detail || '',
    } : null,
  };
}

function cleanText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return '';
  const text = String(value).trim();
  return text === '[object Object]' ? '' : text;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safeMessageId(value) {
  return String(value || 'media').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(-80) || 'media';
}

function defaultMime(type) {
  return ({
    image: 'image/jpeg',
    video: 'video/mp4',
    audio: 'audio/ogg',
    ptt: 'audio/ogg',
    sticker: 'image/webp',
  })[type] || 'application/octet-stream';
}

function mimeExtension(mime, fallback) {
  return ({
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'application/pdf': 'pdf',
  })[String(mime || '').toLowerCase()] || fallback;
}

module.exports = {
  whatsappMediaDescriptor,
  whatsappMessageMetadata,
  whatsappMessageText,
};

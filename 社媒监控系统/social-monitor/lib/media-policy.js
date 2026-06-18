'use strict';

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function isMediaUploadDisabled() {
  return envFlag('DISABLE_MEDIA_UPLOAD', false);
}

function stripMediaFields(message) {
  if (!message || !isMediaUploadDisabled()) return message;
  return {
    ...message,
    has_media: 0,
    media_path: null,
  };
}

module.exports = {
  envFlag,
  isMediaUploadDisabled,
  stripMediaFields,
};

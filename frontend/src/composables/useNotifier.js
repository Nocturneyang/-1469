import { ref } from 'vue';

const STORAGE_KEY = 'social-workbench.notifications.enabled';
const BASE_TITLE = '社媒服务工作台';

export function useNotifier() {
  const enabled = ref(readEnabled());
  const unreadTotal = ref(0);
  let audioContext = null;

  async function toggle() {
    if (enabled.value) {
      enabled.value = false;
      persist();
      return { enabled: false };
    }

    if (typeof window.Notification === 'function' && Notification.permission === 'default') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return { enabled: false, denied: true };
    }

    enabled.value = true;
    persist();
    primeAudio();
    return { enabled: true };
  }

  function notifyInbound({ platform, account, group_id: groupId, groupName } = {}) {
    if (!enabled.value || !document.hidden) return;
    playTone();
    if (typeof window.Notification !== 'function' || Notification.permission !== 'granted') return;
    const notification = new Notification(groupName || '收到新客户消息', {
      body: '工作台收到一条新消息',
      tag: `workbench:${platform || ''}:${account || ''}:${groupId || ''}`,
      renotify: true,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  }

  function setUnreadTotal(value) {
    unreadTotal.value = Math.max(0, Number(value) || 0);
    document.title = unreadTotal.value ? `(${unreadTotal.value}) ${BASE_TITLE}` : BASE_TITLE;
  }

  function persist() {
    try {
      window.localStorage.setItem(STORAGE_KEY, enabled.value ? '1' : '0');
    } catch (_) { }
  }

  function primeAudio() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      audioContext ||= new AudioContext();
      audioContext.resume?.().catch(() => {});
    } catch (_) { }
  }

  function playTone() {
    try {
      primeAudio();
      if (!audioContext) return;
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.frequency.value = 740;
      gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, audioContext.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.16);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start();
      oscillator.stop(audioContext.currentTime + 0.17);
    } catch (_) { }
  }

  return { enabled, unreadTotal, notifyInbound, setUnreadTotal, toggle };
}

function readEnabled() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch (_) {
    return false;
  }
}

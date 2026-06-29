const allowBtn = document.getElementById('allowBtn');
const statusEl = document.getElementById('status');

const params = new URLSearchParams(window.location.search);
const shouldAutoStart = params.get('autostart') === '1';

function setStatus(text, type = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${type}`.trim();
}

async function requestMicrophone() {
  allowBtn.disabled = true;
  setStatus('Waiting for Chrome permission dialog…');

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const storageUpdate = { micPermissionReady: true };
    if (shouldAutoStart) {
      storageUpdate.pendingStartRecording = true;
    }
    await chrome.storage.local.set(storageUpdate);
    setStatus('Microphone allowed. You can close this tab and start recording.', 'ok');
    allowBtn.textContent = 'Done — close this tab';

    setTimeout(() => window.close(), 1200);
  } catch (err) {
    const name = err instanceof DOMException ? err.name : 'Error';
    allowBtn.disabled = false;

    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      setStatus(
        'Permission was blocked. Click Allow in the Chrome dialog, or reset this extension under chrome://settings/content/microphone.',
        'err'
      );
      return;
    }

    if (name === 'NotFoundError') {
      setStatus('No microphone found. Connect a mic and try again.', 'err');
      return;
    }

    if (name === 'NotReadableError') {
      setStatus('Microphone is in use by another app. Close other apps and try again.', 'err');
      return;
    }

    setStatus(`Microphone error: ${err instanceof Error ? err.message : String(err)}`, 'err');
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

allowBtn.addEventListener('click', requestMicrophone);

if (shouldAutoStart) {
  requestMicrophone();
}

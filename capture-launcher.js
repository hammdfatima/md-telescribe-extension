/**
 * Extension-page bridge for meeting-prompt starts.
 * tabCapture.getMediaStreamId must run in an extension page (not a content
 * script / SW-only activeTab path) so Chrome allows capturing the meeting tab.
 * After capture starts, this tab closes and the normal toolbar popup opens.
 */

const titleEl = document.getElementById('title');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
const actionsEl = document.getElementById('actions');
const retryBtn = document.getElementById('retryBtn');
const closeBtn = document.getElementById('closeBtn');

function setStatus(text) {
  statusEl.textContent = text || '';
}

function showError(text) {
  titleEl.textContent = 'Could not start recording';
  errorEl.textContent = text || 'Unknown error';
  errorEl.classList.add('visible');
  actionsEl.hidden = false;
}

function sendToBackground(type, data) {
  return chrome.runtime.sendMessage({ type, target: 'background', data });
}

async function getTabStreamId(tabId, allowRetry = true) {
  try {
    return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (allowRetry && message.toLowerCase().includes('active stream')) {
      await sendToBackground('release-tab-capture');
      await new Promise((resolve) => setTimeout(resolve, 400));
      return getTabStreamId(tabId, false);
    }

    if (message.toLowerCase().includes('active stream')) {
      throw new Error(
        'This tab is still locked from a previous recording. Click Stop Recording, reload the page, or try again.'
      );
    }

    if (message.toLowerCase().includes('activeTab') || message.toLowerCase().includes('not been invoked')) {
      throw new Error(
        'Chrome blocked tab capture. Reload the md telescribe extension, stay on the meeting tab, and try again.'
      );
    }

    throw err;
  }
}

async function resolveLaunchTarget() {
  const params = new URLSearchParams(window.location.search);
  const queryTabId = Number(params.get('tabId'));
  const queryModality = params.get('modality') === 'VIDEO' ? 'VIDEO' : 'AUDIO';

  if (Number.isFinite(queryTabId) && queryTabId > 0) {
    return { tabId: queryTabId, forcedVisitModality: queryModality };
  }

  const { pendingMeetingCapture } = await chrome.storage.session.get('pendingMeetingCapture');
  if (pendingMeetingCapture?.tabId) {
    return {
      tabId: pendingMeetingCapture.tabId,
      forcedVisitModality:
        pendingMeetingCapture.forcedVisitModality === 'VIDEO' ? 'VIDEO' : 'AUDIO',
    };
  }

  throw new Error('Missing meeting tab. Go back to the call and choose Video or Audio visit again.');
}

async function openToolbarPopupAndCloseBridge() {
  const launcherTab = await chrome.tabs.getCurrent().catch(() => null);
  await sendToBackground('finish-meeting-launch', {
    launcherTabId: launcherTab?.id ?? null,
  });
}

async function startFromMeeting() {
  errorEl.textContent = '';
  errorEl.classList.remove('visible');
  actionsEl.hidden = true;
  titleEl.textContent = 'Starting recording…';
  setStatus('Capturing your meeting tab…');

  const { tabId, forcedVisitModality } = await resolveLaunchTarget();

  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    // Capture can still work without focusing the tab.
  }

  setStatus(
    `Starting ${forcedVisitModality === 'VIDEO' ? 'video' : 'audio'} visit capture…`
  );

  const streamId = await getTabStreamId(tabId);
  if (!streamId) {
    throw new Error('Tab capture was denied or failed. Check extension permissions.');
  }

  const response = await sendToBackground('start-recording', {
    streamId,
    tabId,
    forcedVisitModality,
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'Failed to start recording.');
  }

  await chrome.storage.session.remove('pendingMeetingCapture');
  setStatus('Recording started. Opening md telescribe…');
  await openToolbarPopupAndCloseBridge();
}

retryBtn?.addEventListener('click', () => {
  void startFromMeeting().catch((err) => {
    showError(err instanceof Error ? err.message : String(err));
  });
});

closeBtn?.addEventListener('click', () => {
  window.close();
});

void startFromMeeting().catch((err) => {
  // If the hidden bridge tab fails, surface the page so the user can retry.
  void chrome.tabs.getCurrent().then((tab) => {
    if (tab?.id) {
      chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    }
  });
  showError(err instanceof Error ? err.message : String(err));
});

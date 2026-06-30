/**
 * Popup UI — entry point after the user's toolbar click (user gesture).
 */

const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('statusText');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const errorEl = document.getElementById('error');
const sessionPanel = document.getElementById('sessionPanel');
const notesTitleEl = document.getElementById('notesTitle');
const notesSummaryEl = document.getElementById('notesSummary');
const notesContentEl = document.getElementById('notesContent');
const notesDisplayEl = document.getElementById('notesDisplay');
const copyNotesBtn = document.getElementById('copyNotesBtn');
const saveNotesBtn = document.getElementById('saveNotesBtn');
const downloadAudioBtn = document.getElementById('downloadAudioBtn');
const downloadTextBtn = document.getElementById('downloadTextBtn');
const startNewRecordingBtn = document.getElementById('startNewRecordingBtn');
const dismissSessionBtn = document.getElementById('dismissSessionBtn');
const saveStatusEl = document.getElementById('saveStatus');
const recordingButtonsEl = document.getElementById('recordingButtons');
const autoDetectHintEl = document.getElementById('autoDetectHint');
const authPanelEl = document.getElementById('authPanel');
const authLoginFormEl = document.getElementById('authLoginForm');
const authUserBarEl = document.getElementById('authUserBar');
const authUserEmailEl = document.getElementById('authUserEmail');
const usageHintEl = document.getElementById('usageHint');
const loginEmailEl = document.getElementById('loginEmail');
const loginPasswordEl = document.getElementById('loginPassword');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const signupLinkBtn = document.getElementById('signupLinkBtn');
const quotaBlockedPanelEl = document.getElementById('quotaBlockedPanel');
const subscribeBtn = document.getElementById('subscribeBtn');
const recordingSectionEl = document.getElementById('recordingSection');

/** @type {{ user: { email: string, name?: string | null }, usage: { freeNotesRemaining: number, freeNotesLimit: number, hasActiveSubscription: boolean, canGenerateNotes: boolean, subscribeUrl: string } } | null} */
let authSession = null;

/** @type {'idle' | 'recording' | 'saving' | 'syncing' | 'generating' | 'ready' | 'notes' | 'saved'} */
let uiState = 'idle';

/**
 * @type {{
 *   meetingId?: string | null,
 *   note?: { title?: string | null, summary?: string | null, content: string } | null,
 *   notesSaved?: boolean,
 *   processingNotes?: boolean,
 *   files?: { hasAudio?: boolean, hasText?: boolean, audioFilename?: string | null, textFilename?: string | null }
 * } | null}
 */
let currentSession = null;
/** @type {ReturnType<typeof setTimeout>[]} */
let visitModalityRefreshTimers = [];

function clearVisitModalityRefreshTimers() {
  for (const timer of visitModalityRefreshTimers) {
    clearTimeout(timer);
  }
  visitModalityRefreshTimers = [];
}

function scheduleVisitModalityRefresh() {
  clearVisitModalityRefreshTimers();
  for (const delayMs of [4000, 8000]) {
    visitModalityRefreshTimers.push(
      setTimeout(async () => {
        const { recording } = await chrome.storage.local.get('recording');
        if (!recording) {
          return;
        }
        const response = await sendToBackground('refresh-visit-modality');
        if (!response?.ok || !response.visitModality) {
          return;
        }
        const modality = response.visitModality === 'VIDEO' ? 'VIDEO' : 'AUDIO';
        setAutoDetectHint(modality);
        setStatus('recording', `Recording — ${formatDetectedVisitLabel(modality).toLowerCase()}`);
      }, delayMs),
    );
  }
}

function formatDetectedVisitLabel(modality) {
  return modality === 'VIDEO' ? 'Video visit detected' : 'Audio visit detected';
}

function setAutoDetectHint(modality) {
  if (!autoDetectHintEl) {
    return;
  }

  if (!modality) {
    autoDetectHintEl.textContent =
      'Visit type is detected automatically from your telemedicine tab (audio-only vs camera).';
    return;
  }

  autoDetectHintEl.textContent = `${formatDetectedVisitLabel(modality)} — clinical notes will use the matching template.`;
}

function updateAuthUI() {
  const loggedIn = Boolean(authSession?.user);
  const canGenerate = authSession?.usage?.canGenerateNotes ?? false;

  authLoginFormEl?.classList.toggle('hidden', loggedIn);
  authUserBarEl?.classList.toggle('hidden', !loggedIn);
  quotaBlockedPanelEl?.classList.toggle('hidden', !loggedIn || canGenerate);
  recordingSectionEl?.classList.toggle('hidden', !loggedIn || !canGenerate);

  if (loggedIn && authSession) {
    authUserEmailEl.textContent = authSession.user.name || authSession.user.email;
    if (authSession.usage.hasActiveSubscription) {
      usageHintEl.textContent = 'Subscription active — unlimited note generation.';
    } else {
      usageHintEl.textContent = `${authSession.usage.freeNotesRemaining} of ${authSession.usage.freeNotesLimit} free notes remaining.`;
    }
  }
}

async function refreshAuthSession() {
  try {
    const response = await sendToBackground('auth-session');
    if (response?.ok && response.data) {
      authSession = response.data;
      updateAuthUI();
      return authSession;
    }

    authSession = null;
    updateAuthUI();
    return null;
  } catch (err) {
    console.error('[popup] refreshAuthSession failed:', err);
    authSession = null;
    updateAuthUI();
    return null;
  }
}

async function handleLogin() {
  showError('');
  const email = loginEmailEl?.value?.trim();
  const password = loginPasswordEl?.value || '';

  if (!email || !password) {
    showError('Enter your email and password to sign in.');
    return;
  }

  loginBtn.disabled = true;
  try {
    const response = await sendToBackground('auth-login', { email, password });
    if (!response?.ok) {
      throw new Error(response?.error || 'Sign in failed.');
    }

    authSession = response.data;
    loginPasswordEl.value = '';
    updateAuthUI();
    setStatus('idle', 'Signed in');
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    loginBtn.disabled = false;
  }
}

async function handleLogout() {
  await sendToBackground('auth-logout');
  authSession = null;
  updateAuthUI();
  hideSession();
  setStatus('idle', 'Signed out');
  showError('');
}

function openSignupPage() {
  chrome.tabs.create({ url: `${APP_BASE_URL}/signup` });
}

function openSubscribePage(url) {
  const target = url || authSession?.usage?.subscribeUrl || `${APP_BASE_URL}/pricing`;
  void sendToBackground('open-subscribe', { url: target });
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatNotesHtml(content) {
  if (!content?.trim()) {
    return '';
  }

  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      const headingMatch = trimmed.match(/^#{1,3}\s+(.+)$/);

      if (headingMatch) {
        return `<div class="note-heading">${escapeHtml(headingMatch[1])}</div>`;
      }

      if (!trimmed) {
        return '';
      }

      return `<p class="note-paragraph">${escapeHtml(line)}</p>`;
    })
    .filter(Boolean)
    .join('');
}

function notesPlainText(content) {
  return content
    .split('\n')
    .map((line) => line.replace(/^#{1,3}\s+/, '').trimEnd())
    .join('\n')
    .trim();
}

function getNotesContentForSave() {
  if (!notesContentEl.classList.contains('hidden')) {
    return notesContentEl.value.trim();
  }
  return currentSession?.note?.content?.trim() || '';
}

function setNotesViewMode(mode) {
  const isEditing = mode === 'edit';
  const isReadonly = mode === 'readonly';
  const isEmpty = mode === 'empty';

  notesContentEl.classList.toggle('hidden', !isEditing);
  notesDisplayEl.classList.toggle('hidden', isEmpty || isEditing);
  notesDisplayEl.classList.toggle('readonly', isReadonly);
  copyNotesBtn.classList.toggle('hidden', !isReadonly);

  notesContentEl.readOnly = !isEditing;
}

function renderNotesDisplay(content) {
  notesDisplayEl.innerHTML = formatNotesHtml(content);
}

async function copyNotesToClipboard() {
  const content =
    currentSession?.note?.content ||
    notesPlainText(notesDisplayEl.textContent || notesContentEl.value || '');

  if (!content.trim()) {
    return;
  }

  try {
    await navigator.clipboard.writeText(notesPlainText(content));
    setSaveStatus('Notes copied to clipboard.');
    setTimeout(() => {
      if (currentSession?.notesSaved) {
        setSaveStatus('Notes saved to database.');
      } else {
        setSaveStatus('');
      }
    }, 2000);
  } catch {
    showError('Could not copy notes. Try selecting the text manually.');
  }
}

function setStatus(state, message) {
  uiState = state;
  statusEl.dataset.state = state;

  const labels = {
    idle: 'Idle',
    recording: 'Recording',
    saving: 'Finishing recording…',
    syncing: 'Connecting to server…',
    uploading: 'Uploading audio…',
    generating: 'Generating encounter note…',
    ready: 'Recording saved',
    notes: 'Encounter note ready',
    saved: 'Notes saved',
  };

  statusTextEl.textContent = message || labels[state];
  startBtn.disabled = ['recording', 'saving', 'syncing', 'uploading', 'generating'].includes(state);
  stopBtn.disabled = state !== 'recording';
}

function updateSessionButtons() {
  const hasSession = Boolean(currentSession);
  const hasNote = Boolean(currentSession?.note);
  const notesSaved = Boolean(currentSession?.notesSaved);
  const processingNotes = Boolean(currentSession?.processingNotes);
  const hasAudio = Boolean(currentSession?.files?.hasAudio);
  const hasText = Boolean(currentSession?.files?.hasText);

  recordingButtonsEl.classList.toggle('hidden', hasSession);
  sessionPanel.classList.toggle('visible', hasSession);

  saveNotesBtn.classList.toggle('hidden', !hasNote || notesSaved || processingNotes);
  downloadAudioBtn.classList.toggle('hidden', !hasAudio);
  downloadTextBtn.classList.toggle('hidden', !hasText);
  startNewRecordingBtn.classList.toggle('hidden', !notesSaved);
  dismissSessionBtn.classList.toggle('hidden', !hasSession);
}

async function refreshFileAvailability() {
  if (!currentSession) return;

  try {
    const response = await sendToBackground('has-recording-files');
    if (response?.ok && response.files) {
      currentSession = {
        ...currentSession,
        files: response.files,
      };
      updateSessionButtons();
    }
  } catch {
    // Files may be unavailable after service worker restart — buttons stay hidden.
  }
}

function showSession(session) {
  currentSession = session;
  if (session.visitModality) {
    setAutoDetectHint(session.visitModality);
  }

  if (session.subscriptionRequired) {
    quotaBlockedPanelEl?.classList.remove('hidden');
    recordingSectionEl?.classList.add('hidden');
    void refreshAuthSession();
  }

  if (session.note) {
    notesTitleEl.textContent = session.note.title || 'Telemedicine Encounter Note';
    notesSummaryEl.textContent = session.note.summary || '';

    if (session.notesSaved) {
      renderNotesDisplay(session.note.content || '');
      setNotesViewMode('readonly');
      setSaveStatus('Notes saved to database.');
    } else {
      notesContentEl.value = session.note.content || '';
      setNotesViewMode('edit');
      setSaveStatus('');
    }

    setStatus(session.notesSaved ? 'saved' : 'notes');
  } else if (session.processingNotes) {
    notesTitleEl.textContent = 'Telemedicine Encounter Note';
    notesSummaryEl.textContent = '';
    notesContentEl.value = '';
    notesDisplayEl.innerHTML = '';
    setNotesViewMode('empty');
    notesContentEl.classList.remove('hidden');
    setSaveStatus('Generating notes from your recording…');
    setStatus('generating', 'Generating encounter note…');
  } else {
    notesContentEl.value = '';
    notesDisplayEl.innerHTML = '';
    notesSummaryEl.textContent = '';
    setNotesViewMode('empty');
    notesContentEl.classList.remove('hidden');
    setSaveStatus('');
    setStatus('idle', 'Recording saved — notes could not be generated');
  }

  updateSessionButtons();
  refreshFileAvailability();
}

function showSoapNotes(note, notesSaved = false) {
  currentSession = {
    ...currentSession,
    note,
    notesSaved,
  };
  notesTitleEl.textContent = note.title || 'Telemedicine Encounter Note';
  notesSummaryEl.textContent = note.summary || '';

  if (notesSaved) {
    renderNotesDisplay(note.content || '');
    setNotesViewMode('readonly');
    setSaveStatus('Notes saved to database.');
  } else {
    notesContentEl.value = note.content || '';
    setNotesViewMode('edit');
  }

  setStatus(notesSaved ? 'saved' : 'notes');
  updateSessionButtons();
}

function hideSession() {
  currentSession = null;
  setAutoDetectHint(null);
  sessionPanel.classList.remove('visible');
  notesContentEl.value = '';
  notesDisplayEl.innerHTML = '';
  setNotesViewMode('empty');
  notesContentEl.classList.remove('hidden');
  notesSummaryEl.textContent = '';
  setSaveStatus('');
  updateSessionButtons();
  sendToBackground('clear-session').catch(() => {});
}

function formatServerError(message) {
  const text = message || 'Could not generate notes. You can still download the recording.';

  if (text.includes('Subscribe') || text.includes('free notes')) {
    return text;
  }

  if (text.includes('Unauthorized') || text.includes('sign in')) {
    return 'Your session expired. Sign in again to continue.';
  }

  if (text.includes('Transcript is empty') || text.includes('No speech was detected')) {
    return (
      'No speech was captured in this recording. On the other computer: allow microphone, ' +
      'reload the extension, record at least 10 seconds with clear speech, and keep the popup open after stopping.'
    );
  }

  if (text.includes('too small')) {
    return (
      'Recording audio did not upload correctly. Reload the extension from the latest zip, ' +
      'then record again for at least 10 seconds.'
    );
  }

  if (text.includes('Could not reach the server')) {
    return text;
  }

  return `Server sync failed: ${text}`;
}

function showError(text) {
  if (!text) {
    errorEl.textContent = '';
    errorEl.classList.remove('visible');
    return;
  }
  errorEl.textContent = text;
  errorEl.classList.add('visible');
}

function setSaveStatus(text) {
  saveStatusEl.textContent = text || '';
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

    throw err;
  }
}

/** @type {number | null} */
let processingWatchdogId = null;

/** @type {chrome.runtime.Port | null} */
let processingKeepAlivePort = null;

function startProcessingKeepAlive() {
  stopProcessingKeepAlive();
  try {
    processingKeepAlivePort = chrome.runtime.connect({ name: 'processing-keepalive' });
    processingKeepAlivePort.onDisconnect.addListener(() => {
      processingKeepAlivePort = null;
    });
  } catch {
    processingKeepAlivePort = null;
  }
}

function stopProcessingKeepAlive() {
  processingKeepAlivePort?.disconnect();
  processingKeepAlivePort = null;
}

function clearProcessingWatchdog() {
  if (processingWatchdogId !== null) {
    clearInterval(processingWatchdogId);
    processingWatchdogId = null;
  }
}

function startProcessingWatchdog() {
  clearProcessingWatchdog();
  const startedAt = Date.now();

  processingWatchdogId = window.setInterval(() => {
    void (async () => {
      const { processing, pendingSession, syncError } = await chrome.storage.local.get([
        'processing',
        'pendingSession',
        'syncError',
      ]);

      if (pendingSession?.note) {
        clearProcessingWatchdog();
        stopProcessingKeepAlive();
        return;
      }

      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);

      if (processing && elapsedSec >= 15 && elapsedSec < 180) {
        setStatus(
          'generating',
          `Generating encounter note… (${elapsedSec}s — keep this popup open)`
        );
      }

      const stuck = !processing && pendingSession?.processingNotes && !pendingSession?.note;
      if (!stuck && elapsedSec < 180) {
        return;
      }

      if (pendingSession?.meetingId && !pendingSession?.note) {
        const response = await sendToBackground('poll-meeting-note', {
          meetingId: pendingSession.meetingId,
          timeoutMs: 20_000,
        });
        if (response?.ok && response.note) {
          clearProcessingWatchdog();
          stopProcessingKeepAlive();
          return;
        }
      }

      clearProcessingWatchdog();
      stopProcessingKeepAlive();

      const errorMessage =
        syncError ||
        'Could not reach the server or generation timed out. Check your internet connection, then try again.';

      if (pendingSession) {
        showSession({ ...pendingSession, processingNotes: false });
      }

      setStatus('idle');
      showError(errorMessage);
      await chrome.storage.local.set({
        processing: false,
        processingStage: null,
        syncError: errorMessage,
        pendingSession: pendingSession
          ? { ...pendingSession, processingNotes: false }
          : pendingSession,
      });
    })();
  }, 5000);
}

function restoreFromStorage() {
  chrome.storage.local.get(
    ['recording', 'pendingSession', 'processing', 'processingStage', 'syncError'],
    ({ recording, pendingSession, processing, processingStage, syncError }) => {
      if (pendingSession?.files || pendingSession?.meetingId || pendingSession?.processingNotes) {
        if (pendingSession.processingNotes && !processing && !pendingSession.note) {
          if (pendingSession.meetingId) {
            void sendToBackground('poll-meeting-note', {
              meetingId: pendingSession.meetingId,
              timeoutMs: 20_000,
            }).then((response) => {
              if (response?.ok && response.note) {
                return;
              }
              showSession({ ...pendingSession, processingNotes: false });
              setStatus('idle');
              showError(formatServerError(syncError));
            });
            showSession(pendingSession);
            startProcessingKeepAlive();
            startProcessingWatchdog();
            return;
          }

          showSession({ ...pendingSession, processingNotes: false });
          setStatus('idle');
          showError(formatServerError(syncError));
          return;
        }

        showSession(pendingSession);
        if (pendingSession.processingNotes || processing) {
          startProcessingKeepAlive();
          startProcessingWatchdog();
        }
        if (syncError && !pendingSession.processingNotes) {
          showError(formatServerError(syncError));
        }
        return;
      }

      if (processing) {
        applyProcessingStage(processingStage);
        startProcessingWatchdog();
        return;
      }

      clearProcessingWatchdog();

      if (syncError) {
        setStatus('idle');
        showError(`Server sync failed: ${syncError}`);
        chrome.storage.local.remove('syncError');
        return;
      }

      if (recording) {
        chrome.storage.session.get('detectedVisitModality', ({ detectedVisitModality }) => {
          if (detectedVisitModality) {
            setAutoDetectHint(detectedVisitModality);
            setStatus(
              'recording',
              `Recording — ${formatDetectedVisitLabel(detectedVisitModality).toLowerCase()}`,
            );
          } else {
            setStatus('recording');
          }
        });
      }
    }
  );
}

function applyProcessingStage(stage) {
  switch (stage) {
    case 'generating':
      setStatus('generating', 'Generating encounter note…');
      break;
    case 'uploading':
      setStatus('uploading', 'Uploading audio in background…');
      break;
    case 'transcribing':
      setStatus('saving', 'Saving & transcribing…');
      break;
    default:
      setStatus('uploading', 'Uploading audio…');
      break;
  }
}

const MIC_WINDOWS_HELP =
  'Chrome shows microphone as allowed, but Windows may still be blocking it. ' +
  'Open Windows Settings → Privacy → Microphone → turn on "Allow apps to access your microphone" ' +
  'and enable Google Chrome. Then reload the extension.';

async function getMicrophonePermissionState() {
  try {
    const result = await navigator.permissions.query({ name: 'microphone' });
    return result.state;
  } catch {
    return 'unknown';
  }
}

function openMicSetupTab() {
  chrome.tabs.create({ url: chrome.runtime.getURL('mic-setup.html?autostart=1') });
}

async function ensureMicrophonePermission() {
  const permissionState = await getMicrophonePermissionState();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    await chrome.storage.local.set({ micPermissionReady: true });
    return;
  } catch (err) {
    const name = err instanceof DOMException ? err.name : 'Error';

    if (name === 'NotFoundError') {
      throw new Error('No microphone found. Connect a mic and try again.');
    }

    if (name === 'NotReadableError') {
      throw new Error('Microphone is in use by another app. Close other apps and try again.');
    }

    if (permissionState === 'granted') {
      throw new Error(MIC_WINDOWS_HELP);
    }

    openMicSetupTab();
    throw new Error(
      'Click Allow in the Chrome dialog on the tab that just opened, then click Start Recording again.'
    );
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
  }
}

function isRestrictedTabUrl(url) {
  if (!url) return true;
  const restrictedPrefixes = [
    'chrome://',
    'chrome-extension://',
    'edge://',
    'about:',
    'devtools://',
    'view-source:',
  ];
  return restrictedPrefixes.some((prefix) => url.startsWith(prefix));
}

async function startRecording() {
  showError('');
  hideSession();
  updateSessionButtons();
  setStatus('idle', 'Checking account…');

  try {
    const session = await refreshAuthSession();
    if (!session?.user) {
      setStatus('idle', 'Sign in required');
      showError('Sign in to your md telescribe account before recording.');
      return;
    }

    if (!session.usage.canGenerateNotes) {
      setStatus('idle', 'Subscription required');
      showError('You have used your free notes. Subscribe to continue generating clinical notes.');
      updateAuthUI();
      return;
    }

    setStatus('idle', 'Requesting mic…');
    const { recording } = await chrome.storage.local.get('recording');
    const { recordingState = 'idle' } = await chrome.storage.session.get('recordingState');

    if (recording || recordingState === 'recording' || recordingState === 'starting') {
      setStatus('recording');
      showError('Recording is already in progress. Click Stop Recording first.');
      return;
    }

    await ensureMicrophonePermission();
    setStatus('idle', 'Starting capture…');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      throw new Error('No active tab found. Focus a normal browser tab and try again.');
    }

    if (isRestrictedTabUrl(tab.url || '')) {
      throw new Error(
        'This tab cannot be captured. Open a regular HTTPS page (e.g. meet.google.com) and try again.'
      );
    }

    const streamId = await getTabStreamId(tab.id);

    if (!streamId) {
      throw new Error('Tab capture was denied or failed. Check extension permissions.');
    }

    const response = await sendToBackground('start-recording', {
      streamId,
      tabId: tab.id,
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to start recording in offscreen document.');
    }

    const detectedModality = response.visitModality === 'VIDEO' ? 'VIDEO' : 'AUDIO';
    setAutoDetectHint(detectedModality);
    setStatus('recording', `Recording — ${formatDetectedVisitLabel(detectedModality).toLowerCase()}`);
    scheduleVisitModalityRefresh();
    await chrome.storage.local.set({ recording: true, processing: false, syncError: null });
  } catch (err) {
    console.error('[popup] startRecording failed:', err);
    setStatus('idle');
    setAutoDetectHint(null);
    showError(err instanceof Error ? err.message : String(err));
    await chrome.storage.local.set({ recording: false, processing: false });
    await chrome.storage.session.set({ recordingState: 'idle' });
  }
}

async function stopRecording() {
  clearVisitModalityRefreshTimers();
  showError('');
  setStatus('saving', 'Finishing recording…');
  startBtn.disabled = true;
  stopBtn.disabled = true;

  try {
    const response = await sendToBackground('stop-recording');

    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to stop recording.');
    }

    const session = {
      meetingId: null,
      note: null,
      notesSaved: false,
      processingNotes: true,
      files: response.files ?? null,
    };

    showSession(session);
    startProcessingKeepAlive();
    startProcessingWatchdog();
  } catch (err) {
    console.error('[popup] stopRecording failed:', err);
    setStatus('idle');
    showError(err instanceof Error ? err.message : String(err));
    await chrome.storage.local.set({ recording: false, processing: false, processingStage: null });
    await chrome.storage.session.set({ recordingState: 'idle' });
    clearProcessingWatchdog();
    stopProcessingKeepAlive();
  } finally {
    startBtn.disabled = ['recording', 'saving', 'syncing', 'generating'].includes(uiState);
    stopBtn.disabled = uiState !== 'recording';
  }
}

async function downloadRecordingFile(fileType) {
  showError('');
  const btn = fileType === 'text' ? downloadTextBtn : downloadAudioBtn;
  btn.disabled = true;

  try {
    const response = await sendToBackground('download-recording-file', { fileType });

    if (!response?.ok) {
      throw new Error(response?.error || 'Download failed.');
    }

    let blob;
    if (response.text) {
      blob = new Blob([response.text], { type: response.mimeType || 'text/plain;charset=utf-8' });
    } else if (response.audioBuffer) {
      blob = new Blob([response.audioBuffer], { type: response.mimeType || 'audio/webm' });
    } else {
      throw new Error('Download failed — no file data returned.');
    }

    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({
        url,
        filename: response.filename,
        saveAs: Boolean(response.saveAs),
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  } catch (err) {
    console.error('[popup] download failed:', err);
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    btn.disabled = false;
  }
}

async function saveNotes() {
  if (!currentSession?.meetingId) {
    showError('No meeting notes to save.');
    return;
  }

  showError('');
  setSaveStatus('Saving…');
  saveNotesBtn.disabled = true;

  try {
    const response = await sendToBackground('save-note', {
      meetingId: currentSession.meetingId,
      title: notesTitleEl.textContent,
      summary: notesSummaryEl.textContent,
      content: getNotesContentForSave(),
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to save notes.');
    }

    if (response.note) {
      currentSession = {
        ...currentSession,
        note: {
          ...response.note,
          content: getNotesContentForSave(),
        },
        notesSaved: true,
      };
      await chrome.storage.local.set({ pendingSession: currentSession });
    }

    showSoapNotes(currentSession.note, true);
  } catch (err) {
    console.error('[popup] saveNotes failed:', err);
    setSaveStatus('');
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    saveNotesBtn.disabled = false;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes.pendingSession?.newValue) {
    const session = changes.pendingSession.newValue;
    if (session.files || session.meetingId || session.note || session.processingNotes) {
      showSession(session);
    }
    if (session.note) {
      clearProcessingWatchdog();
      stopProcessingKeepAlive();
    }
  }

  if (changes.processing?.newValue === true) {
    chrome.storage.local.get('processingStage', ({ processingStage }) => {
      applyProcessingStage(processingStage);
    });
  }

  if (changes.processingStage?.newValue) {
    applyProcessingStage(changes.processingStage.newValue);
  }

  if (changes.processing?.newValue === false && changes.pendingSession?.newValue?.note) {
    showSession(changes.pendingSession.newValue);
  }

  if (changes.syncError?.newValue) {
    const session = changes.pendingSession?.newValue;
    if (session?.meetingId && !session?.note) {
      void sendToBackground('poll-meeting-note', {
        meetingId: session.meetingId,
        timeoutMs: 20_000,
      }).then((response) => {
        if (response?.ok && response.note) {
          return;
        }
        setStatus('idle', 'Could not generate notes');
        showError(formatServerError(changes.syncError.newValue));
      });
      return;
    }

    setStatus('idle', 'Could not generate notes');
    showError(formatServerError(changes.syncError.newValue));
  }

  if (changes.micPermissionReady?.newValue === true && changes.pendingStartRecording?.newValue === true) {
    chrome.storage.local.remove('pendingStartRecording');
    chrome.storage.local.get(['recording'], ({ recording }) => {
      if (!recording) {
        startRecording();
      }
    });
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== 'popup') return;

  if (message.type === 'recording-error') {
    setStatus('idle');
    showError(message.data);
    chrome.storage.local.set({ recording: false, processing: false });
    chrome.storage.session.set({ recordingState: 'idle' });
  }

  if (message.type === 'sync-status') {
    if (message.data?.stage === 'uploading') {
      setStatus('uploading', 'Uploading audio…');
    }
    if (message.data?.stage === 'generating') {
      setStatus('generating', 'Generating encounter note…');
    }
  }

  if (message.type === 'session-processing' && message.data?.files) {
    showSession({
      meetingId: null,
      note: null,
      notesSaved: false,
      processingNotes: true,
      files: message.data.files,
    });
    startProcessingKeepAlive();
    startProcessingWatchdog();
  }

  if (message.type === 'processing-error') {
    clearProcessingWatchdog();
    stopProcessingKeepAlive();
    if (message.data?.session) {
      showSession(message.data.session);
    }
    setStatus('idle', 'Could not generate notes');
    showError(formatServerError(message.data?.error));
  }

  if (message.type === 'notes-ready' && message.data) {
    currentSession = message.data;
    showSession(message.data);
    void refreshAuthSession();
    clearProcessingWatchdog();
    stopProcessingKeepAlive();
  }

  if (message.type === 'transcript-ready' && message.data?.files && currentSession) {
    currentSession = { ...currentSession, files: message.data.files };
    updateSessionButtons();
  }
});

startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);
loginBtn.addEventListener('click', handleLogin);
logoutBtn.addEventListener('click', handleLogout);
signupLinkBtn.addEventListener('click', openSignupPage);
subscribeBtn.addEventListener('click', () => openSubscribePage());
loginPasswordEl?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    void handleLogin();
  }
});
saveNotesBtn.addEventListener('click', saveNotes);
copyNotesBtn.addEventListener('click', copyNotesToClipboard);
downloadAudioBtn.addEventListener('click', () => downloadRecordingFile('audio'));
downloadTextBtn.addEventListener('click', () => downloadRecordingFile('text'));
startNewRecordingBtn.addEventListener('click', startRecording);
dismissSessionBtn.addEventListener('click', () => {
  hideSession();
  setStatus('idle');
});

updateSessionButtons();
setAutoDetectHint(null);
void refreshAuthSession().then(() => restoreFromStorage());

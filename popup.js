/**
 * Popup UI — entry point after the user's toolbar click (user gesture).
 */

const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('statusText');
const micMeterEl = document.getElementById('micMeter');
const startVideoBtn = document.getElementById('startVideoBtn');
const startAudioBtn = document.getElementById('startAudioBtn');
const startInPersonBtn = document.getElementById('startInPersonBtn');
const offlineVideoTemplateBtn = document.getElementById('offlineVideoTemplateBtn');
const offlineAudioTemplateBtn = document.getElementById('offlineAudioTemplateBtn');
const offlineTemplateRow = document.getElementById('offlineTemplateRow');
const visitTypeSubheadingEl = document.querySelector('.visit-type-subheading');
const pauseBtn = document.getElementById('pauseBtn');
const pauseBtnLabel = document.getElementById('pauseBtnLabel');
const pauseBtnIcon = document.getElementById('pauseBtnIcon');
const stopBtn = document.getElementById('stopBtn');
const errorEl = document.getElementById('error');
const sessionPanel = document.getElementById('sessionPanel');
const notesTitleEl = document.getElementById('notesTitle');
const notesSummaryEl = document.getElementById('notesSummary');
const notesContentEl = document.getElementById('notesContent');
const notesDisplayEl = document.getElementById('notesDisplay');
const notesGeneratingEl = document.getElementById('notesGenerating');
const notesGeneratingDetailEl = document.getElementById('notesGeneratingDetail');
const statusSpinnerEl = document.querySelector('.status-spinner');
const copyNotesBtn = document.getElementById('copyNotesBtn');
const saveNotesBtn = document.getElementById('saveNotesBtn');
const notesConsentRow = document.getElementById('notesConsentRow');
const notesConsentCheckbox = document.getElementById('notesConsentCheckbox');
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
const togglePasswordBtn = document.getElementById('togglePasswordBtn');
const authCredentialsStepEl = document.getElementById('authCredentialsStep');
const authMfaStepEl = document.getElementById('authMfaStep');
const mfaCodeInputEl = document.getElementById('mfaCodeInput');
const verifyMfaBtn = document.getElementById('verifyMfaBtn');
const cancelMfaBtn = document.getElementById('cancelMfaBtn');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const signupLinkBtn = document.getElementById('signupLinkBtn');
const quotaBlockedPanelEl = document.getElementById('quotaBlockedPanel');
const subscribeBtn = document.getElementById('subscribeBtn');
const recordingSectionEl = document.getElementById('recordingSection');
const userAvatarEl = document.getElementById('userAvatar');

/** @type {{ user: { email: string, name?: string | null }, usage: { freeNotesRemaining: number, freeNotesLimit: number, hasActiveSubscription: boolean, canGenerateNotes: boolean, subscribeUrl: string } } | null} */
let authSession = null;

/** Pending MFA token after password succeeds on a 2FA account. */
let pendingMfaToken = null;

/** @type {'idle' | 'recording' | 'paused' | 'saving' | 'syncing' | 'uploading' | 'generating' | 'ready' | 'notes' | 'saved'} */
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
        const { recording, recordingPaused } = await chrome.storage.local.get([
          'recording',
          'recordingPaused',
        ]);
        if (!recording) {
          return;
        }
        const response = await sendToBackground('refresh-visit-modality');
        if (!response?.ok || !response.visitModality) {
          return;
        }
        const modality =
          response.visitModality === 'VIDEO'
            ? 'VIDEO'
            : response.visitModality === 'IN_PERSON'
              ? 'IN_PERSON'
              : 'AUDIO';
        setAutoDetectHint(modality);
        // Never overwrite a paused UI — that resets the Pause/Resume button.
        if (recordingPaused || uiState === 'paused') {
          return;
        }
        setStatus('recording', `Recording — ${formatDetectedVisitLabel(modality).toLowerCase()}`);
      }, delayMs),
    );
  }
}

function formatDetectedVisitLabel(modality) {
  if (modality === 'VIDEO') return 'Video visit detected';
  if (modality === 'IN_PERSON') return 'In-person visit';
  return 'Audio visit detected';
}

function getUserInitials(user) {
  const source = (user?.name || user?.email || 'MD').trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

function setAutoDetectHint(modality) {
  if (!autoDetectHintEl) {
    return;
  }

  const defaultHtml =
    'Use <strong>Video visit</strong> or <strong>Audio visit</strong> for telemedicine. Use <strong>In-person visit</strong> to record a face-to-face conversation with the microphone. Wear headphones for clearer doctor transcription on telemedicine visits.';

  if (!modality) {
    autoDetectHintEl.innerHTML = defaultHtml;
    return;
  }

  if (modality === 'IN_PERSON') {
    autoDetectHintEl.textContent =
      'Recording in-person visit — place the microphone between you and the patient. Clinical notes will use the video visit template.';
    return;
  }

  autoDetectHintEl.textContent = `Recording as ${formatDetectedVisitLabel(modality).toLowerCase()} — clinical notes will use the matching template.`;
}

function setVisitStartButtonsDisabled(disabled) {
  if (startVideoBtn) startVideoBtn.disabled = disabled;
  if (startAudioBtn) startAudioBtn.disabled = disabled;
  if (startInPersonBtn) startInPersonBtn.disabled = disabled;
  if (offlineVideoTemplateBtn) offlineVideoTemplateBtn.disabled = disabled;
  if (offlineAudioTemplateBtn) offlineAudioTemplateBtn.disabled = disabled;
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
    if (userAvatarEl) {
      userAvatarEl.textContent = getUserInitials(authSession.user);
    }
    if (!authSession.usage) {
      usageHintEl.textContent = 'Signed in - reconnecting...';
    } else if (authSession.usage.hasActiveSubscription) {
      usageHintEl.textContent = 'Subscription active - unlimited note generation.';
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
    if (response?.code === 'MFA_REQUIRED' && response?.mfaToken) {
      showMfaStep(response.mfaToken);
      setStatus('idle', 'Enter authenticator code');
      return;
    }
    if (!response?.ok) {
      throw new Error(response?.error || 'Sign in failed.');
    }

    authSession = response.data;
    loginPasswordEl.value = '';
    hideMfaStep();
    updateAuthUI();
    setStatus('idle', 'Signed in');
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    loginBtn.disabled = false;
  }
}

function showMfaStep(mfaToken) {
  pendingMfaToken = mfaToken;
  showError('');
  authCredentialsStepEl?.classList.add('hidden');
  authMfaStepEl?.classList.remove('hidden');
  if (mfaCodeInputEl) {
    mfaCodeInputEl.value = '';
    mfaCodeInputEl.focus();
  }
}

function hideMfaStep() {
  pendingMfaToken = null;
  authMfaStepEl?.classList.add('hidden');
  authCredentialsStepEl?.classList.remove('hidden');
  if (mfaCodeInputEl) {
    mfaCodeInputEl.value = '';
  }
}

async function handleVerifyMfa() {
  showError('');
  const code = (mfaCodeInputEl?.value || '').replace(/\D/g, '');

  if (!pendingMfaToken) {
    hideMfaStep();
    showError('Sign-in session expired. Enter your email and password again.');
    return;
  }

  if (code.length !== 6) {
    showError('Enter the 6-digit code from your authenticator app.');
    return;
  }

  if (verifyMfaBtn) verifyMfaBtn.disabled = true;
  try {
    const response = await sendToBackground('auth-verify-mfa', {
      mfaToken: pendingMfaToken,
      code,
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'Invalid MFA code.');
    }

    authSession = response.data;
    if (loginPasswordEl) loginPasswordEl.value = '';
    hideMfaStep();
    updateAuthUI();
    setStatus('idle', 'Signed in');
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    if (mfaCodeInputEl) {
      mfaCodeInputEl.focus();
      mfaCodeInputEl.select();
    }
  } finally {
    if (verifyMfaBtn) verifyMfaBtn.disabled = false;
  }
}

async function handleLogout() {
  await sendToBackground('auth-logout');
  authSession = null;
  hideMfaStep();
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
  const isLoading = mode === 'loading';

  notesContentEl.classList.toggle('hidden', !isEditing);
  notesDisplayEl.classList.toggle('hidden', isEmpty || isEditing || isLoading);
  notesDisplayEl.classList.toggle('readonly', isReadonly);
  notesGeneratingEl?.classList.toggle('hidden', !isLoading);
  // Show copy whenever notes exist (edit or readonly); consent still gates the action.
  copyNotesBtn.classList.toggle('hidden', isEmpty || isLoading);

  notesContentEl.readOnly = !isEditing;
  updateCopyNotesEnabled();
}

function setNotesGeneratingDetail(stage) {
  if (!notesGeneratingDetailEl) return;
  if (stage === 'uploading') {
    notesGeneratingDetailEl.textContent =
      'Uploading your recording securely. Keep this popup open.';
    return;
  }
  if (stage === 'transcribing') {
    notesGeneratingDetailEl.textContent =
      'Transcribing the visit conversation. Keep this popup open.';
    return;
  }
  notesGeneratingDetailEl.textContent =
    'Transcribing your visit and drafting the SOAP note. Keep this popup open.';
}

function renderNotesDisplay(content) {
  notesDisplayEl.innerHTML = formatNotesHtml(content);
}

async function copyNotesToClipboard() {
  if (!notesConsentCheckbox?.checked) {
    showError('Please confirm patient recording consent and note review before copying.');
    return;
  }

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

function updateCopyNotesEnabled() {
  if (!copyNotesBtn) return;
  const hasContent = Boolean(
    (
      currentSession?.note?.content ||
      notesContentEl?.value ||
      notesDisplayEl?.textContent ||
      ''
    ).trim(),
  );
  const consented = Boolean(notesConsentCheckbox?.checked);
  const isVisible = !copyNotesBtn.classList.contains('hidden');
  copyNotesBtn.disabled = !isVisible || !hasContent || !consented;
}

function blockUnverifiedNotesClipboard(event) {
  if (notesConsentCheckbox?.checked) {
    return;
  }
  event.preventDefault();
  showError('Please confirm patient recording consent and note review before copying.');
}

/** @type {ReturnType<typeof setInterval> | null} */
let micMeterPollTimer = null;

function setMicMeterVisible(visible) {
  if (!micMeterEl) return;
  micMeterEl.classList.toggle('hidden', !visible);
  micMeterEl.setAttribute('aria-hidden', visible ? 'false' : 'true');
  if (!visible) {
    stopMicMeterPolling();
    updateMicMeterBars([0, 0, 0, 0, 0]);
  } else {
    startMicMeterPolling();
  }
}

/**
 * @param {number[]} bars
 */
function updateMicMeterBars(bars) {
  if (!micMeterEl) return;
  const nodes = micMeterEl.querySelectorAll('.mic-meter-bar');
  nodes.forEach((bar, index) => {
    const value = Math.max(0, Math.min(1, Number(bars?.[index]) || 0));
    // Keep a small floor so idle bars are visible, then scale speech strongly.
    const heightPct = Math.max(8, Math.round(8 + value * 92));
    bar.style.height = `${heightPct}%`;
  });
}

function stopMicMeterPolling() {
  if (micMeterPollTimer) {
    clearInterval(micMeterPollTimer);
    micMeterPollTimer = null;
  }
}

function startMicMeterPolling() {
  stopMicMeterPolling();
  const poll = async () => {
    if (uiState !== 'recording' && uiState !== 'paused') {
      stopMicMeterPolling();
      return;
    }
    try {
      const response = await sendToBackground('get-mic-level');
      if (response?.ok && Array.isArray(response.bars)) {
        updateMicMeterBars(response.bars);
      }
    } catch {
      // Ignore transient MV3 messaging blips while recording.
    }
  };
  void poll();
  micMeterPollTimer = setInterval(() => {
    void poll();
  }, 60);
}

function setPauseButton(paused) {
  if (!pauseBtn || !pauseBtnLabel || !pauseBtnIcon) return;

  if (paused) {
    pauseBtnLabel.textContent = 'Resume';
    pauseBtnIcon.innerHTML =
      '<polygon points="8,5 19,12 8,19"></polygon>';
    pauseBtn.setAttribute('aria-label', 'Resume recording');
  } else {
    pauseBtnLabel.textContent = 'Pause';
    pauseBtnIcon.innerHTML =
      '<rect x="6" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect>';
    pauseBtn.setAttribute('aria-label', 'Pause recording');
  }
}

function setStatus(state, message) {
  uiState = state;
  statusEl.dataset.state = state;

  const labels = {
    idle: 'Ready to record',
    recording: 'Recording',
    paused: 'Recording paused',
    saving: 'Finishing recording…',
    syncing: 'Connecting to server…',
    uploading: 'Uploading audio…',
    generating: 'Generating encounter note…',
    ready: 'Recording saved',
    notes: 'Encounter note ready',
    saved: 'Notes saved',
  };

  statusTextEl.textContent = message || labels[state];
  statusSpinnerEl?.classList.toggle(
    'hidden',
    !['saving', 'syncing', 'uploading', 'generating'].includes(state),
  );
  const startDisabled = ['recording', 'paused', 'saving', 'syncing', 'uploading', 'generating'].includes(
    state,
  );
  setVisitStartButtonsDisabled(startDisabled);
  const visitStartRow = document.getElementById('visitStartRow');
  const visitTypeHeading = document.getElementById('visitTypeHeading');
  const isActivelyRecording = ['recording', 'paused'].includes(state);
  const hideChooser = startDisabled && state !== 'idle';
  visitStartRow?.classList.toggle('hidden', hideChooser);
  visitTypeHeading?.classList.toggle('hidden', hideChooser);
  offlineTemplateRow?.classList.toggle('hidden', hideChooser);
  visitTypeSubheadingEl?.classList.toggle('hidden', hideChooser);
  autoDetectHintEl?.classList.toggle('hidden', hideChooser);
  recordingButtonsEl?.classList.toggle('hidden', !isActivelyRecording);
  stopBtn.disabled = !isActivelyRecording;
  pauseBtn.disabled = !isActivelyRecording;
  setPauseButton(state === 'paused');
  setMicMeterVisible(isActivelyRecording);
}

function updateSaveNotesEnabled() {
  const hasNote = Boolean(currentSession?.note);
  const notesSaved = Boolean(currentSession?.notesSaved);
  const processingNotes = Boolean(currentSession?.processingNotes);
  const canSave = hasNote && !notesSaved && !processingNotes;
  const consented = Boolean(notesConsentCheckbox?.checked);

  saveNotesBtn.disabled = !canSave || !consented;
  updateCopyNotesEnabled();
}

function updateSessionButtons() {
  const hasSession = Boolean(currentSession);
  const hasNote = Boolean(currentSession?.note);
  const notesSaved = Boolean(currentSession?.notesSaved);
  const processingNotes = Boolean(currentSession?.processingNotes);
  const hasAudio = Boolean(currentSession?.files?.hasAudio);
  const hasText = Boolean(currentSession?.files?.hasText);
  const showSave = hasNote && !notesSaved && !processingNotes;

  recordingButtonsEl.classList.toggle(
    'hidden',
    hasSession || !['recording', 'paused'].includes(uiState),
  );
  const visitStartRow = document.getElementById('visitStartRow');
  const visitTypeHeading = document.getElementById('visitTypeHeading');
  visitStartRow?.classList.toggle('hidden', hasSession);
  visitTypeHeading?.classList.toggle('hidden', hasSession);
  offlineTemplateRow?.classList.toggle('hidden', hasSession);
  visitTypeSubheadingEl?.classList.toggle('hidden', hasSession);
  autoDetectHintEl?.classList.toggle('hidden', hasSession);
  sessionPanel.classList.toggle('visible', hasSession);

  // Keep consent visible whenever notes exist so copy cannot bypass verification.
  const showConsent = hasNote && !processingNotes;
  notesConsentRow?.classList.toggle('hidden', !showConsent);
  if (!showConsent && notesConsentCheckbox) {
    notesConsentCheckbox.checked = false;
  }
  const consentTextEl = notesConsentRow?.querySelector('.consent-label span');
  if (consentTextEl) {
    consentTextEl.textContent = currentSession?.offlineTemplate
      ? 'I confirm I have personally reviewed this progress note in its entirety for documentation accuracy. COPY & SAVE are available ONLY after I acknowledge & confirm this to be true.'
      : 'I confirm the patient consented to the audio recording of this medical encounter/visit and I have personally reviewed the progress note in its entirety for documentation accuracy. COPY & SAVE are available ONLY after I acknowledge & confirm this to be true.';
  }

  saveNotesBtn.classList.toggle('hidden', !showSave);
  downloadAudioBtn.classList.toggle('hidden', !hasAudio);
  downloadTextBtn.classList.toggle('hidden', !hasText);
  startNewRecordingBtn.classList.toggle('hidden', !notesSaved);
  dismissSessionBtn.classList.toggle('hidden', !hasSession);
  updateSaveNotesEnabled();
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
    notesTitleEl.textContent = session.note.title || 'Encounter Note';
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
    notesTitleEl.textContent = 'Encounter Note';
    notesSummaryEl.textContent = '';
    notesContentEl.value = '';
    notesDisplayEl.innerHTML = '';
    setNotesViewMode('loading');
    setNotesGeneratingDetail('generating');
    setSaveStatus('');
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
  notesTitleEl.textContent = note.title || 'Encounter Note';
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
    // Periodic pings help keep the service worker alive during long Whisper/note jobs.
    processingKeepAlivePort.postMessage({ type: 'ping', at: Date.now() });
    const pingId = window.setInterval(() => {
      try {
        processingKeepAlivePort?.postMessage({ type: 'ping', at: Date.now() });
      } catch {
        window.clearInterval(pingId);
      }
    }, 20_000);
    processingKeepAlivePort._pingId = pingId;
  } catch {
    processingKeepAlivePort = null;
  }
}

function stopProcessingKeepAlive() {
  const pingId = processingKeepAlivePort?._pingId;
  if (typeof pingId === 'number') {
    window.clearInterval(pingId);
  }
  processingKeepAlivePort?.disconnect();
  processingKeepAlivePort = null;
}

function clearProcessingWatchdog() {
  if (processingWatchdogId !== null) {
    clearInterval(processingWatchdogId);
    processingWatchdogId = null;
  }
}

/** Allow up to 10 minutes for long patient visits (Whisper + note generation). */
const PROCESSING_MAX_WAIT_SEC = 600;

function startProcessingWatchdog() {
  clearProcessingWatchdog();
  const startedAt = Date.now();

  processingWatchdogId = window.setInterval(() => {
    void (async () => {
      if (uiState === 'recording' || uiState === 'paused') {
        clearProcessingWatchdog();
        stopProcessingKeepAlive();
        return;
      }

      const { processing, pendingSession, syncError, recording } = await chrome.storage.local.get([
        'processing',
        'pendingSession',
        'syncError',
        'recording',
      ]);

      if (recording) {
        clearProcessingWatchdog();
        stopProcessingKeepAlive();
        return;
      }

      if (pendingSession?.note) {
        clearProcessingWatchdog();
        stopProcessingKeepAlive();
        return;
      }

      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);

      if ((processing || pendingSession?.processingNotes) && elapsedSec >= 15) {
        setStatus(
          'generating',
          `Generating encounter note… (${elapsedSec}s — keep this popup open)`,
        );
        if (currentSession?.processingNotes || pendingSession?.processingNotes) {
          setNotesViewMode('loading');
        }
      }

      // While the background is still actively processing, keep waiting.
      if (processing && elapsedSec < PROCESSING_MAX_WAIT_SEC) {
        return;
      }

      const stuck = !processing && pendingSession?.processingNotes && !pendingSession?.note;

      // Not stuck and not past the hard limit yet.
      if (!stuck && elapsedSec < PROCESSING_MAX_WAIT_SEC) {
        return;
      }

      if (pendingSession?.meetingId && !pendingSession?.note) {
        const response = await sendToBackground('poll-meeting-note', {
          meetingId: pendingSession.meetingId,
          timeoutMs: 120_000,
        });
        if (response?.ok && response.note) {
          clearProcessingWatchdog();
          stopProcessingKeepAlive();
          return;
        }

        // One more attempt: ask background to resume note generation.
        const retry = await sendToBackground('retry-generate-notes', {
          meetingId: pendingSession.meetingId,
        });
        if (retry?.ok && retry.note) {
          clearProcessingWatchdog();
          stopProcessingKeepAlive();
          return;
        }
      }

      clearProcessingWatchdog();
      stopProcessingKeepAlive();

      const errorMessage =
        syncError ||
        'Could not reach the server or generation timed out. Longer visits can take several minutes — keep this popup open and try again.';

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
    ['recording', 'recordingPaused', 'pendingSession', 'processing', 'processingStage', 'syncError'],
    ({ recording, recordingPaused, pendingSession, processing, processingStage, syncError }) => {
      // Live capture always wins over a leftover notes/error session.
      if (recording) {
        clearProcessingWatchdog();
        hideSessionPanelOnly();
        chrome.storage.session.get(
          ['detectedVisitModality', 'recordingState'],
          ({ detectedVisitModality, recordingState }) => {
            const paused = recordingPaused || recordingState === 'paused';
            if (paused) {
              setStatus('paused', 'Recording paused — click Resume to continue');
              return;
            }
            if (detectedVisitModality) {
              setAutoDetectHint(detectedVisitModality);
              setStatus(
                'recording',
                `Recording — ${formatDetectedVisitLabel(detectedVisitModality).toLowerCase()}`,
              );
            } else {
              setStatus('recording');
            }
          },
        );
        return;
      }

      if (pendingSession?.files || pendingSession?.meetingId || pendingSession?.processingNotes) {
        if (pendingSession.processingNotes && !processing && !pendingSession.note) {
          if (pendingSession.meetingId) {
            void sendToBackground('poll-meeting-note', {
              meetingId: pendingSession.meetingId,
              timeoutMs: 120_000,
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
    }
  );
}

/** Hide the notes panel without clearing storage (used when a live recording is active). */
function hideSessionPanelOnly() {
  currentSession = null;
  sessionPanel.classList.remove('visible');
  notesContentEl.value = '';
  notesDisplayEl.innerHTML = '';
  setNotesViewMode('empty');
  notesContentEl.classList.remove('hidden');
  notesSummaryEl.textContent = '';
  setSaveStatus('');
  updateSessionButtons();
}

async function restoreRecordingStatusFromStorage() {
  const { recording, recordingPaused } = await chrome.storage.local.get([
    'recording',
    'recordingPaused',
  ]);
  if (!recording) {
    setStatus('idle');
    return;
  }

  const { recordingState, detectedVisitModality } = await chrome.storage.session.get([
    'recordingState',
    'detectedVisitModality',
  ]);
  const paused = recordingPaused || recordingState === 'paused';
  if (paused) {
    setStatus('paused', 'Recording paused — click Resume to continue');
    return;
  }
  setStatus(
    'recording',
    detectedVisitModality
      ? `Recording — ${formatDetectedVisitLabel(detectedVisitModality).toLowerCase()}`
      : 'Recording',
  );
}

function applyProcessingStage(stage) {
  switch (stage) {
    case 'generating':
      setNotesGeneratingDetail('generating');
      if (currentSession?.processingNotes) {
        setNotesViewMode('loading');
      }
      setStatus('generating', 'Generating encounter note…');
      break;
    case 'uploading':
      setNotesGeneratingDetail('uploading');
      if (currentSession?.processingNotes) {
        setNotesViewMode('loading');
      }
      setStatus('uploading', 'Uploading audio in background…');
      break;
    case 'transcribing':
      setNotesGeneratingDetail('transcribing');
      if (currentSession?.processingNotes) {
        setNotesViewMode('loading');
      }
      setStatus('saving', 'Saving & transcribing…');
      break;
    default:
      setNotesGeneratingDetail('uploading');
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

async function ensureCapturePermissionForUrl(url) {
  if (!url || isRestrictedTabUrl(url) || !chrome.permissions?.request) {
    return;
  }

  try {
    const originPattern = `${new URL(url).origin}/*`;
    const already = await chrome.permissions.contains({ origins: [originPattern] });
    if (already) {
      return;
    }

    const granted = await chrome.permissions.request({
      origins: ['http://*/*', 'https://*/*'],
    });
    if (!granted) {
      throw new Error(
        'Allow md telescribe site access for this meeting page: chrome://extensions → md telescribe → Details → Site access → On all sites.'
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('Site access')) {
      throw err;
    }
  }
}

/**
 * @param {'AUDIO' | 'VIDEO'} [forcedVisitModality]
 * @param {{ tabId?: number }} [options]
 */
async function startRecording(forcedVisitModality = 'AUDIO', options = {}) {
  const visitModality = forcedVisitModality === 'VIDEO' ? 'VIDEO' : 'AUDIO';
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

    if (!session.usage?.canGenerateNotes) {
      setStatus('idle', 'Subscription required');
      showError('You have used your free notes. Subscribe to continue generating clinical notes.');
      updateAuthUI();
      return;
    }

    setStatus('idle', 'Requesting mic…');
    const { recording } = await chrome.storage.local.get('recording');
    const { recordingState = 'idle' } = await chrome.storage.session.get('recordingState');

    if (
      recording ||
      recordingState === 'recording' ||
      recordingState === 'paused' ||
      recordingState === 'starting'
    ) {
      setStatus(recordingState === 'paused' ? 'paused' : 'recording');
      showError('Recording is already in progress. Click Stop Recording first.');
      return;
    }

    await chrome.storage.local.set({ pendingVisitModality: visitModality });
    await ensureMicrophonePermission();
    setStatus('idle', `Starting ${visitModality === 'VIDEO' ? 'video' : 'audio'} visit…`);

    /** @type {chrome.tabs.Tab | null} */
    let tab = null;
    if (!options.tabId) {
      const stored = await chrome.storage.session.get(['preferredMeetingTabId', 'preferredMeetingTabAt']);
      const preferredAgeMs = Date.now() - (stored.preferredMeetingTabAt || 0);
      if (stored.preferredMeetingTabId && preferredAgeMs < 30 * 60 * 1000) {
        options.tabId = stored.preferredMeetingTabId;
      }
    }
    if (options.tabId) {
      tab = await chrome.tabs.get(options.tabId).catch(() => null);
      if (tab?.id) {
        try {
          await chrome.tabs.update(tab.id, { active: true });
          if (tab.windowId != null) {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
        } catch {
          // Continue — targetTabId capture can still work.
        }
      }
    }

    if (!tab?.id) {
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      tab = activeTab ?? null;
    }

    if (!tab?.id) {
      throw new Error('No active tab found. Focus your meeting tab and try again.');
    }

    if (isRestrictedTabUrl(tab.url || '')) {
      throw new Error(
        'This tab cannot be captured. Keep the Google Meet / Zoom tab focused and try again.'
      );
    }

    await ensureCapturePermissionForUrl(tab.url || '');

    let streamId;
    try {
      streamId = await getTabStreamId(tab.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes('activetab') || message.toLowerCase().includes('not been invoked')) {
        throw new Error(
          'Chrome blocked tab capture for this meeting. Open chrome://extensions → md telescribe → Details → Site access → On all sites, then try again from the meeting tab.'
        );
      }
      throw err;
    }

    if (!streamId) {
      throw new Error('Tab capture was denied or failed. Check extension permissions.');
    }

    const response = await sendToBackground('start-recording', {
      streamId,
      tabId: tab.id,
      forcedVisitModality: visitModality,
    });

    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to start recording in offscreen document.');
    }

    setAutoDetectHint(visitModality);
    setStatus(
      'recording',
      `Recording — ${visitModality === 'VIDEO' ? 'video visit' : 'audio visit'}`,
    );
    await chrome.storage.local.set({
      recording: true,
      processing: false,
      syncError: null,
      pendingVisitModality: null,
    });
    await chrome.storage.session.remove([
      'pendingMeetingAutoStart',
      'pendingMeetingCapture',
      'preferredMeetingTabId',
      'preferredMeetingTabAt',
    ]);
  } catch (err) {
    console.error('[popup] startRecording failed:', err);
    setStatus('idle');
    setAutoDetectHint(null);
    showError(err instanceof Error ? err.message : String(err));
    await chrome.storage.local.set({ recording: false, processing: false, pendingVisitModality: null });
    await chrome.storage.session.set({ recordingState: 'idle' });
  }
}

/**
 * Mic-only in-person visit — records the room conversation without capturing a meeting tab.
 */
async function startInPersonRecording() {
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

    if (!session.usage?.canGenerateNotes) {
      setStatus('idle', 'Subscription required');
      showError('You have used your free notes. Subscribe to continue generating clinical notes.');
      updateAuthUI();
      return;
    }

    setStatus('idle', 'Requesting mic…');
    const { recording } = await chrome.storage.local.get('recording');
    const { recordingState = 'idle' } = await chrome.storage.session.get('recordingState');

    if (
      recording ||
      recordingState === 'recording' ||
      recordingState === 'paused' ||
      recordingState === 'starting'
    ) {
      setStatus(recordingState === 'paused' ? 'paused' : 'recording');
      showError('Recording is already in progress. Click Stop Recording first.');
      return;
    }

    await chrome.storage.local.set({ pendingVisitModality: 'IN_PERSON' });
    await ensureMicrophonePermission();
    setStatus('idle', 'Starting in-person visit…');

    const response = await sendToBackground('start-dictation');
    if (!response?.ok) {
      throw new Error(response?.error || 'Failed to start in-person recording.');
    }

    setAutoDetectHint('IN_PERSON');
    setStatus('recording', 'Recording — in-person visit');
    scheduleVisitModalityRefresh();
    await chrome.storage.local.set({
      recording: true,
      processing: false,
      syncError: null,
      pendingVisitModality: null,
    });
    await chrome.storage.session.remove([
      'pendingMeetingAutoStart',
      'pendingMeetingCapture',
      'preferredMeetingTabId',
      'preferredMeetingTabAt',
    ]);
  } catch (err) {
    console.error('[popup] startInPersonRecording failed:', err);
    setStatus('idle');
    setAutoDetectHint(null);
    showError(err instanceof Error ? err.message : String(err));
    await chrome.storage.local.set({ recording: false, processing: false, pendingVisitModality: null });
    await chrome.storage.session.set({ recordingState: 'idle' });
  }
}

/**
 * Open a blank VIDEO/AUDIO encounter template in the note editor for manual fill-in.
 * @param {'AUDIO' | 'VIDEO'} visitModality
 */
async function openOfflineTemplate(visitModality) {
  if (typeof getOfflineNoteTemplate !== 'function') {
    showError('Note templates failed to load. Reload the extension and try again.');
    return;
  }

  if (!authSession?.user) {
    showError('Sign in to open an offline note template.');
    return;
  }

  showError('');
  setVisitStartButtonsDisabled(true);
  setStatus('starting', 'Opening note template…');

  try {
    const response = await sendToBackground('open-offline-template', { visitModality });
    if (!response?.ok || !response.meetingId) {
      throw new Error(response?.error || 'Could not create a meeting for this template.');
    }

    const content = getOfflineNoteTemplate(visitModality);
    const session = {
      meetingId: response.meetingId,
      visitModality,
      notesSaved: false,
      processingNotes: false,
      offlineTemplate: true,
      note: {
        title:
          visitModality === 'AUDIO'
            ? 'Telemedicine Audio Encounter Note'
            : 'Telemedicine Video Encounter Note',
        summary: 'Blank offline template — fill in clinical details, then save.',
        content,
      },
      files: { hasAudio: false, hasText: false },
    };

    await chrome.storage.local.set({
      pendingSession: session,
      syncError: null,
      processing: false,
      processingStage: null,
    });
    showSession(session);
    setStatus('notes', 'Fill in the note template, then save.');
    notesContentEl?.focus();
  } catch (err) {
    console.error('[popup] openOfflineTemplate failed:', err);
    showError(err instanceof Error ? err.message : String(err));
    setStatus('idle', 'Ready to record');
  } finally {
    setVisitStartButtonsDisabled(false);
  }
}

async function consumeMeetingAutostart() {
  // Meeting prompt only opens the extension now. Visit type is chosen here.
  const params = new URLSearchParams(window.location.search);
  const tabId = Number(params.get('tabId'));
  if (Number.isFinite(tabId) && tabId > 0) {
    await chrome.storage.session.set({
      preferredMeetingTabId: tabId,
      preferredMeetingTabAt: Date.now(),
    });
  }

  await chrome.storage.session.remove(['pendingMeetingAutoStart', 'pendingMeetingCapture']);

  if (params.get('autostartMeeting') === '1') {
    try {
      window.history.replaceState({}, '', chrome.runtime.getURL('popup.html'));
    } catch {
      // Ignore history errors in extension pages.
    }
    setStatus('idle', 'Choose Video, Audio, or In-person visit to start');
  }

  return false;
}

async function pauseOrResumeRecording() {
  showError('');
  hideSessionPanelOnly();

  // Prefer stored state over uiState so a stale "Recording" label still resumes correctly.
  const { recordingPaused } = await chrome.storage.local.get('recordingPaused');
  const { recordingState } = await chrome.storage.session.get('recordingState');
  const isPaused =
    recordingPaused === true || recordingState === 'paused' || uiState === 'paused';
  const pausing = !isPaused;

  pauseBtn.disabled = true;
  // Optimistic UI so the label flips immediately.
  setPauseButton(pausing);

  try {
    const response = await sendToBackground(pausing ? 'pause-recording' : 'resume-recording');
    if (!response?.ok) {
      setPauseButton(!pausing);
      throw new Error(
        response?.error || (pausing ? 'Could not pause recording.' : 'Could not resume recording.'),
      );
    }

    if (pausing) {
      clearVisitModalityRefreshTimers();
      setStatus('paused', 'Recording paused — click Resume to continue');
    } else {
      const { detectedVisitModality } = await chrome.storage.session.get('detectedVisitModality');
      setStatus(
        'recording',
        detectedVisitModality
          ? `Recording — ${formatDetectedVisitLabel(detectedVisitModality).toLowerCase()}`
          : 'Recording',
      );
      scheduleVisitModalityRefresh();
    }
  } catch (err) {
    console.error('[popup] pause/resume failed:', err);
    showError(err instanceof Error ? err.message : String(err));
    await restoreRecordingStatusFromStorage();
  }
}

async function stopRecording() {
  clearVisitModalityRefreshTimers();
  showError('');
  setStatus('saving', 'Finishing recording…');
  setVisitStartButtonsDisabled(true);
  pauseBtn.disabled = true;
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
    const isActivelyRecording = ['recording', 'paused'].includes(uiState);
    const startDisabled = ['recording', 'paused', 'saving', 'syncing', 'generating'].includes(uiState);
    setVisitStartButtonsDisabled(startDisabled);
    recordingButtonsEl?.classList.toggle('hidden', !isActivelyRecording);
    stopBtn.disabled = !isActivelyRecording;
    pauseBtn.disabled = !isActivelyRecording;
    setPauseButton(uiState === 'paused');
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

  if (!notesConsentCheckbox?.checked) {
    showError(
      currentSession?.offlineTemplate
        ? 'Please confirm you reviewed the note before saving.'
        : 'Please confirm patient recording consent and note review before saving.',
    );
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

    if (notesConsentCheckbox) {
      notesConsentCheckbox.checked = false;
    }
    showSoapNotes(currentSession.note, true);
  } catch (err) {
    console.error('[popup] saveNotes failed:', err);
    setSaveStatus('');
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    updateSaveNotesEnabled();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes.pendingSession?.newValue) {
    if (uiState === 'recording' || uiState === 'paused') {
      return;
    }
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
    if (uiState === 'recording' || uiState === 'paused') {
      return;
    }
    chrome.storage.local.get('processingStage', ({ processingStage }) => {
      applyProcessingStage(processingStage);
    });
  }

  if (changes.processingStage?.newValue) {
    if (uiState === 'recording' || uiState === 'paused') {
      return;
    }
    applyProcessingStage(changes.processingStage.newValue);
  }

  if (changes.processing?.newValue === false && changes.pendingSession?.newValue?.note) {
    if (uiState === 'recording' || uiState === 'paused') {
      return;
    }
    showSession(changes.pendingSession.newValue);
  }

  if (changes.syncError?.newValue) {
    if (uiState === 'recording' || uiState === 'paused') {
      return;
    }
    const session = changes.pendingSession?.newValue;
    if (session?.meetingId && !session?.note) {
      void sendToBackground('poll-meeting-note', {
        meetingId: session.meetingId,
        timeoutMs: 120_000,
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

  if (changes.recordingPaused) {
    if (changes.recording?.newValue === false) {
      // stopped
    } else if (changes.recordingPaused.newValue === true) {
      setStatus('paused', 'Recording paused — click Resume to continue');
    } else if (changes.recordingPaused.newValue === false && changes.recording?.newValue !== false) {
      chrome.storage.session.get('detectedVisitModality', ({ detectedVisitModality }) => {
        setStatus(
          'recording',
          detectedVisitModality
            ? `Recording — ${formatDetectedVisitLabel(detectedVisitModality).toLowerCase()}`
            : 'Recording',
        );
      });
    }
  }

  if (changes.recording?.newValue === true) {
    chrome.storage.session.get(
      ['detectedVisitModality', 'forcedVisitModality', 'recordingState'],
      ({ detectedVisitModality, forcedVisitModality, recordingState }) => {
        if (recordingState === 'paused') {
          setStatus('paused', 'Recording paused — click Resume to continue');
          return;
        }
        const modality = forcedVisitModality || detectedVisitModality;
        setStatus(
          'recording',
          modality
            ? `Recording — ${formatDetectedVisitLabel(modality).toLowerCase()}`
            : 'Recording',
        );
        setAutoDetectHint(modality === 'VIDEO' || modality === 'AUDIO' ? modality : null);
        showError('');
      }
    );
  }

  if (changes.recording?.newValue === false && !changes.processing?.newValue) {
    if (uiState === 'recording' || uiState === 'paused') {
      setStatus('idle');
    }
  }

  if (changes.micPermissionReady?.newValue === true && changes.pendingStartRecording?.newValue === true) {
    chrome.storage.local.remove('pendingStartRecording');
    chrome.storage.local.get(['recording', 'pendingVisitModality'], ({ recording, pendingVisitModality }) => {
      if (!recording) {
        startRecording(pendingVisitModality === 'VIDEO' ? 'VIDEO' : 'AUDIO');
      }
    });
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== 'popup') return;

  if (message.type === 'mic-level') {
    if (uiState === 'recording' || uiState === 'paused') {
      setMicMeterVisible(true);
      updateMicMeterBars(message.data?.bars || [0, 0, 0, 0, 0]);
    }
    return;
  }

  if (message.type === 'recording-error') {
    setStatus('idle');
    showError(message.data);
    chrome.storage.local.set({ recording: false, processing: false });
    chrome.storage.session.set({ recordingState: 'idle' });
  }

  if (message.type === 'sync-status') {
    // Ignore late upload/generate updates while a new capture is already running.
    if (uiState === 'recording' || uiState === 'paused') {
      return;
    }
    if (message.data?.stage === 'uploading') {
      applyProcessingStage('uploading');
    }
    if (message.data?.stage === 'generating') {
      applyProcessingStage('generating');
    }
  }

  if (message.type === 'session-processing' && message.data?.files) {
    if (uiState === 'recording' || uiState === 'paused') {
      return;
    }
    showSession({
      meetingId: null,
      note: null,
      notesSaved: false,
      processingNotes: true,
      files: message.data.files,
    });
    setNotesViewMode('loading');
    setNotesGeneratingDetail('uploading');
    startProcessingKeepAlive();
    startProcessingWatchdog();
  }

  if (message.type === 'processing-error') {
    if (uiState === 'recording' || uiState === 'paused') {
      // Stale Whisper/note failure from a previous stop — do not interrupt live capture.
      return;
    }
    clearProcessingWatchdog();
    stopProcessingKeepAlive();
    if (message.data?.session) {
      showSession(message.data.session);
    }
    setStatus('idle', 'Could not generate notes');
    showError(formatServerError(message.data?.error));
  }

  if (message.type === 'notes-ready' && message.data) {
    if (uiState === 'recording' || uiState === 'paused') {
      return;
    }
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

startVideoBtn?.addEventListener('click', () => startRecording('VIDEO'));
startAudioBtn?.addEventListener('click', () => startRecording('AUDIO'));
startInPersonBtn?.addEventListener('click', () => startInPersonRecording());
offlineVideoTemplateBtn?.addEventListener('click', () => openOfflineTemplate('VIDEO'));
offlineAudioTemplateBtn?.addEventListener('click', () => openOfflineTemplate('AUDIO'));
notesContentEl?.addEventListener('copy', blockUnverifiedNotesClipboard);
notesContentEl?.addEventListener('cut', blockUnverifiedNotesClipboard);
notesDisplayEl?.addEventListener('copy', blockUnverifiedNotesClipboard);
notesDisplayEl?.addEventListener('cut', blockUnverifiedNotesClipboard);
pauseBtn.addEventListener('click', pauseOrResumeRecording);
stopBtn.addEventListener('click', stopRecording);
loginBtn.addEventListener('click', handleLogin);
logoutBtn.addEventListener('click', handleLogout);
signupLinkBtn.addEventListener('click', openSignupPage);
subscribeBtn.addEventListener('click', () => openSubscribePage());
verifyMfaBtn?.addEventListener('click', () => {
  void handleVerifyMfa();
});
cancelMfaBtn?.addEventListener('click', () => {
  hideMfaStep();
  showError('');
  setStatus('idle', 'Sign in required');
});
togglePasswordBtn?.addEventListener('click', () => {
  if (!loginPasswordEl) return;
  const showing = loginPasswordEl.type === 'text';
  loginPasswordEl.type = showing ? 'password' : 'text';
  togglePasswordBtn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  togglePasswordBtn.setAttribute('title', showing ? 'Show password' : 'Hide password');
  togglePasswordBtn.querySelector('.password-icon-show')?.classList.toggle('hidden', !showing);
  togglePasswordBtn.querySelector('.password-icon-hide')?.classList.toggle('hidden', showing);
});
loginPasswordEl?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    void handleLogin();
  }
});
mfaCodeInputEl?.addEventListener('input', () => {
  if (!mfaCodeInputEl) return;
  mfaCodeInputEl.value = mfaCodeInputEl.value.replace(/\D/g, '').slice(0, 6);
});
mfaCodeInputEl?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    void handleVerifyMfa();
  }
});
saveNotesBtn.addEventListener('click', saveNotes);
notesConsentCheckbox?.addEventListener('change', updateSaveNotesEnabled);
copyNotesBtn.addEventListener('click', copyNotesToClipboard);
downloadAudioBtn.addEventListener('click', () => downloadRecordingFile('audio'));
downloadTextBtn.addEventListener('click', () => downloadRecordingFile('text'));
startNewRecordingBtn.addEventListener('click', () => {
  hideSession();
  showError('');
  setAutoDetectHint(null);
  setStatus('idle', 'Choose Video, Audio, or In-person visit to start');
  void restoreRecordingStatusFromStorage();
});
dismissSessionBtn.addEventListener('click', () => {
  hideSession();
  showError('');
  void restoreRecordingStatusFromStorage();
});

updateSessionButtons();
setAutoDetectHint(null);
void refreshAuthSession().then(async () => {
  restoreFromStorage();
  try {
    await consumeMeetingAutostart();
  } catch (err) {
    console.error('[popup] meeting autostart failed:', err);
  }
});

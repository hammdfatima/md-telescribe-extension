/**
 * MV3 Service Worker — orchestrates the offscreen document and routes messages.
 */

importScripts('config.js', 'api.js', 'visit-modality.js');

const OFFSCREEN_URL = 'offscreen.html';

/** @type {{ audio?: { buffer: ArrayBuffer, filename: string }, text?: { text: string, filename: string } } | null} */
let pendingRecordingFiles = null;

/**
 * Bumped when the user dismisses a session or starts a new recording so late
 * Whisper/note-generation results cannot overwrite an active capture UI.
 */
let processingEpoch = 0;

function invalidateProcessing() {
  processingEpoch += 1;
}

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });

  if (existingContexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab audio and microphone, mix streams, and record via MediaRecorder.',
  });
}

async function closeOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });

  if (existingContexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

function sendToOffscreen(type, data) {
  return chrome.runtime.sendMessage({ type, target: 'offscreen', data });
}

function buildTranscriptFileFromSegments(segments, filename) {
  const timestamp = filename?.replace(/^recording-|\.webm$/g, '') || new Date().toISOString();
  const header = `Tab + Mic Recorder — 2-Person Conversation\nRecorded: ${timestamp}\n`;
  const legend = `Speakers: Doctor = microphone | Patient = call/tab audio\n${'='.repeat(50)}\n\n`;

  const body =
    segments?.length > 0
      ? segments
          .map((segment) => {
            const speaker = segment.speaker || 'Speaker';
            return `[${speaker}] ${segment.text}`;
          })
          .join('\n\n')
      : '(No speech detected in this recording.)';

  return `${header}${legend}${body}`;
}

function isPlaceholderTranscript(text) {
  return (
    !text ||
    text.includes('Transcript is being generated on the server') ||
    text.includes('(No speech detected in this recording.)')
  );
}

async function refreshTranscriptFile(meetingId, filename) {
  try {
    const meeting = await getMeeting(meetingId);
    const segments = meeting?.segments || [];
    if (!segments.length) {
      return;
    }

    const transcriptText = buildTranscriptFileFromSegments(segments, filename);
    const textFilename = filename?.replace(/\.webm$/, '.txt') || 'recording.txt';

    pendingRecordingFiles = {
      ...pendingRecordingFiles,
      text: { text: transcriptText, filename: textFilename },
    };

    const stored = await chrome.storage.local.get('pendingSession');
    if (stored.pendingSession) {
      await chrome.storage.local.set({
        pendingSession: {
          ...stored.pendingSession,
          files: buildSessionFilesMeta(),
        },
      });
    }

    notifyPopup('transcript-ready', { files: buildSessionFilesMeta() });
  } catch (err) {
    console.warn('[background] refreshTranscriptFile failed:', err);
  }
}

async function resolveTranscriptText() {
  const file = pendingRecordingFiles?.text;
  if (!file?.text) {
    return null;
  }

  if (!isPlaceholderTranscript(file.text)) {
    return { text: file.text, filename: file.filename };
  }

  const { pendingSession } = await chrome.storage.local.get('pendingSession');
  if (!pendingSession?.meetingId) {
    return { text: file.text, filename: file.filename };
  }

  const meeting = await getMeeting(pendingSession.meetingId);
  const segments = meeting?.segments || [];
  if (!segments.length) {
    return { text: file.text, filename: file.filename };
  }

  const transcriptText = buildTranscriptFileFromSegments(
    segments,
    pendingRecordingFiles?.audio?.filename || 'recording.webm'
  );

  pendingRecordingFiles = {
    ...pendingRecordingFiles,
    text: { text: transcriptText, filename: file.filename },
  };

  return { text: transcriptText, filename: file.filename };
}

function notifyPopup(type, data) {
  chrome.runtime.sendMessage({ type, target: 'popup', data }).catch(() => {});
}

/**
 * OS notification when the extension popup may be closed.
 * @param {{ id?: string, title: string, message: string }} options
 */
function showOsNotification({ id, title, message }) {
  if (!chrome.notifications?.create) {
    return;
  }

  const notificationId = id || `mdts-${Date.now()}`;
  try {
    chrome.notifications.create(notificationId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      priority: 2,
    });
  } catch (err) {
    console.warn('[background] showOsNotification failed:', err);
  }
}

function dataUrlToArrayBuffer(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferFromAudioResult(result) {
  if (result?.audioDataUrl) {
    return dataUrlToArrayBuffer(result.audioDataUrl);
  }
  if (result?.audioBuffer instanceof ArrayBuffer) {
    return result.audioBuffer.slice(0);
  }
  return null;
}

function buildSessionFilesMeta() {
  return {
    hasAudio: Boolean(pendingRecordingFiles?.audio),
    hasText: Boolean(pendingRecordingFiles?.text),
    audioFilename: pendingRecordingFiles?.audio?.filename ?? null,
    textFilename: pendingRecordingFiles?.text?.filename ?? null,
  };
}

async function getRecordingState() {
  const { recordingState = 'idle' } = await chrome.storage.session.get('recordingState');
  return recordingState;
}

async function setRecordingState(state) {
  await chrome.storage.session.set({ recordingState: state });
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

async function openExtensionUi() {
  try {
    if (chrome.action?.openPopup) {
      await chrome.action.openPopup();
      return { opened: 'popup' };
    }
  } catch (err) {
    console.warn('[background] openPopup failed, falling back to window:', err);
  }

  return openExtensionUiNearToolbar();
}

/** Fallback when toolbar popup cannot be opened — place near the top-right (extension icons). */
async function openExtensionUiNearToolbar() {
  const current = await chrome.windows
    .getLastFocused({ windowTypes: ['normal'] })
    .catch(() => null);

  const width = 420;
  const height = 680;
  let left = 80;
  let top = 80;

  if (current) {
    left = Math.max(0, (current.left ?? 0) + (current.width ?? 1280) - width - 24);
    top = Math.max(0, (current.top ?? 0) + 72);
  }

  await chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width,
    height,
    left,
    top,
    focused: true,
  });
  return { opened: 'window' };
}

/**
 * After the capture bridge finishes, close it and open the normal toolbar popup.
 * @param {{ launcherTabId?: number, launcherWindowId?: number }} data
 */
async function finishMeetingLaunch(data = {}) {
  const { launcherTabId, launcherWindowId } = data;

  if (launcherTabId) {
    try {
      await chrome.tabs.remove(launcherTabId);
    } catch {
      // Already closed.
    }
  }

  if (launcherWindowId) {
    try {
      await chrome.windows.remove(launcherWindowId);
    } catch {
      // Already closed.
    }
  }

  // Give Chrome a beat so openPopup is not blocked by the bridge window/tab.
  await new Promise((resolve) => setTimeout(resolve, 120));
  return openExtensionUi();
}

async function getTabStreamId(tabId, allowRetry = true) {
  try {
    return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (allowRetry && message.toLowerCase().includes('active stream')) {
      await releaseTabCapture();
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

/**
 * Shared path used by the toolbar popup and the in-meeting prompt.
 * @param {{ tabId: number, streamId: string, forcedVisitModality: 'AUDIO' | 'VIDEO' }} params
 */
async function beginTabRecording({ tabId, streamId, forcedVisitModality }) {
  pendingRecordingFiles = null;
  invalidateProcessing();

  const state = await getRecordingState();
  if (state === 'starting' || state === 'recording' || state === 'paused' || state === 'stopping') {
    return { ok: false, error: 'Recording is already in progress. Click Stop Recording first.' };
  }

  await setRecordingState('starting');

  try {
    const normalizedModality = forcedVisitModality === 'VIDEO' ? 'VIDEO' : 'AUDIO';
    const pageVisitModality =
      normalizedModality || (await detectVisitModalityFromTab(tabId));
    await chrome.storage.session.set({
      recordingTabId: tabId ?? null,
      pageVisitModality,
      detectedVisitModality: pageVisitModality,
      forcedVisitModality: normalizedModality,
    });

    await ensureOffscreenDocument();
    const result = await sendToOffscreen('start-recording', {
      streamId,
      tabId,
      pageVisitModality,
      forcedVisitModality: normalizedModality,
    });

    if (result?.ok) {
      await setRecordingState('recording');
      const detectedVisitModality =
        normalizedModality ?? mergeVisitModality(pageVisitModality, result.visitModality);
      await chrome.storage.session.set({
        detectedVisitModality,
        forcedVisitModality: normalizedModality,
      });
      await chrome.storage.local.set({
        recording: true,
        recordingPaused: false,
        processing: false,
        syncError: null,
        pendingVisitModality: null,
        pendingMeetingStart: null,
      });
      wakeBackend().catch(() => {});
      // Create meeting early so in-visit Whisper chunks can land before Stop.
      try {
        await ensureActiveMeeting(normalizedModality);
      } catch (err) {
        console.warn('[background] early meeting create failed:', err);
      }
      return {
        ...result,
        visitModality:
          normalizedModality ?? mergeVisitModality(pageVisitModality, result.visitModality),
      };
    }

    await setRecordingState('idle');
    return result;
  } catch (err) {
    await setRecordingState('idle');
    throw err;
  }
}

/**
 * Open the extension from the in-page meeting prompt (no auto-start).
 * Visit type is chosen inside the extension UI.
 * @param {{ tabId?: number }} data
 */
async function openExtensionFromMeeting(data, senderTabId) {
  const tabId = data?.tabId ?? senderTabId;

  if (!tabId) {
    return { ok: false, error: 'No meeting tab found. Focus the call tab and try again.' };
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id || isRestrictedTabUrl(tab.url || '')) {
    return {
      ok: false,
      error: 'This tab cannot be captured. Stay on the meeting page and try again.',
    };
  }

  // Remember which meeting tab to capture when the user picks Video/Audio in the popup.
  await chrome.storage.session.set({
    preferredMeetingTabId: tabId,
    preferredMeetingTabAt: Date.now(),
  });

  dismissMeetingPromptOnTab(tabId).catch(() => {});

  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    // Extension UI can still open without focusing the tab.
  }

  // Prefer the real toolbar popup. If Chrome blocks it (no user-gesture in the SW),
  // ask the content script to show an in-page modal instead of a full window/tab.
  try {
    if (chrome.action?.openPopup) {
      await chrome.action.openPopup();
      return { ok: true, opened: 'popup' };
    }
  } catch (err) {
    console.warn('[background] openPopup from meeting failed:', err);
  }

  return { ok: true, opened: 'modal' };
}

/**
 * Start recording from the in-page meeting prompt, then open the extension UI.
 * @deprecated Prefer openExtensionFromMeeting — visit type is chosen in the popup.
 * @param {{ tabId?: number, forcedVisitModality?: 'AUDIO' | 'VIDEO' }} data
 */
async function startRecordingFromMeeting(data, senderTabId) {
  return openExtensionFromMeeting(data, senderTabId);
}

/**
 * Opens the normal extension UI near the toolbar for the meeting tab.
 * @param {{ tabId: number, forcedVisitModality?: 'AUDIO' | 'VIDEO' }} params
 */
async function openMeetingAutostartUi({ tabId }) {
  return openExtensionFromMeeting({ tabId }, tabId);
}

/**
 * @deprecated Kept for older pending mic-resume paths.
 */
async function openCaptureLauncher({ tabId, forcedVisitModality }) {
  return openExtensionFromMeeting({ tabId }, tabId);
}

async function dismissMeetingPromptOnTab(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      target: 'meeting-prompt',
      type: 'dismiss',
    });
  } catch {
    // Tab may not have the content script (or was closed).
  }
}

async function resumePendingMeetingStart() {
  const { pendingMeetingStart, micPermissionReady } = await chrome.storage.local.get([
    'pendingMeetingStart',
    'micPermissionReady',
  ]);

  if (!pendingMeetingStart?.tabId || !micPermissionReady) {
    return;
  }

  await chrome.storage.local.remove('pendingMeetingStart');

  try {
    await openExtensionFromMeeting({ tabId: pendingMeetingStart.tabId }, pendingMeetingStart.tabId);
  } catch (err) {
    notifyPopup(
      'recording-error',
      err instanceof Error ? err.message : String(err)
    );
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.micPermissionReady?.newValue === true) {
    void resumePendingMeetingStart();
  }
});

async function releaseTabCapture() {
  try {
    await ensureOffscreenDocument();
    await sendToOffscreen('force-cleanup');
  } catch {
    // Offscreen may be unavailable — still close the document below.
  }

  try {
    await closeOffscreenDocument();
  } catch {
    // ignore
  }

  pendingRecordingFiles = null;
  await chrome.storage.session.remove('activeMeetingId');
  await setRecordingState('idle');
  await chrome.storage.local.set({ recording: false, recordingPaused: false, processing: false });
}

/** @type {Promise<void> | null} */
let processingRecordingPromise = null;

/** In-flight live Whisper uploads so stop→notes can wait for the last chunks. */
/** @type {Set<Promise<unknown>>} */
const pendingLiveTranscriptUploads = new Set();

/**
 * Create a meeting as soon as recording starts so live chunks can be transcribed.
 * @param {'AUDIO' | 'VIDEO' | 'IN_PERSON'} visitModality
 */
async function ensureActiveMeeting(visitModality) {
  const stored = await chrome.storage.session.get('activeMeetingId');
  if (stored.activeMeetingId) {
    return stored.activeMeetingId;
  }

  await wakeBackend().catch(() => {});
  const title = `Visit ${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const meeting = await createMeeting(title, visitModality);
  await chrome.storage.session.set({ activeMeetingId: meeting.id });
  return meeting.id;
}

/**
 * @param {{ audioDataUrl?: string, seq?: number }} data
 * @param {'AUDIO' | 'VIDEO' | 'IN_PERSON'} [fallbackModality]
 */
async function handleLiveTranscriptChunk(data, fallbackModality = 'AUDIO') {
  if (!data?.audioDataUrl) {
    return { ok: false, error: 'Missing audio chunk.' };
  }

  let { activeMeetingId } = await chrome.storage.session.get('activeMeetingId');
  if (!activeMeetingId) {
    try {
      activeMeetingId = await ensureActiveMeeting(fallbackModality);
    } catch (err) {
      console.warn('[background] could not create meeting for live chunk:', err);
      return { ok: false, error: 'No active meeting for live transcription.' };
    }
  }

  const uploadPromise = (async () => {
    const audioBuffer = dataUrlToArrayBuffer(data.audioDataUrl);
    if (audioBuffer.byteLength < 8 * 1024) {
      return;
    }
    await transcribeMeetingChunk(activeMeetingId, audioBuffer);
  })()
    .catch((err) => {
      console.warn('[background] live transcript chunk failed:', err);
    })
    .finally(() => {
      pendingLiveTranscriptUploads.delete(uploadPromise);
    });

  pendingLiveTranscriptUploads.add(uploadPromise);
  return { ok: true };
}

async function flushPendingLiveTranscripts() {
  const pending = [...pendingLiveTranscriptUploads];
  if (pending.length === 0) {
    return;
  }
  await Promise.allSettled(pending);
}

async function updatePendingSessionMeeting(meetingId, visitModality) {
  const stored = await chrome.storage.local.get('pendingSession');
  await chrome.storage.local.set({
    pendingSession: {
      ...(stored.pendingSession || {}),
      meetingId,
      processingNotes: true,
      visitModality,
      files: buildSessionFilesMeta(),
    },
  });
}

async function finishNotesSession(meetingId, note, visitModality, filename) {
  await refreshTranscriptFile(meetingId, filename);

  const session = {
    meetingId,
    note,
    notesSaved: false,
    processingNotes: false,
    visitModality,
    files: buildSessionFilesMeta(),
  };

  await stopProcessingAlarm();
  await chrome.storage.local.set({
    pendingSession: session,
    processing: false,
    processingStage: null,
    syncError: null,
  });
  await chrome.storage.session.remove([
    'recordingTabId',
    'pageVisitModality',
    'detectedVisitModality',
  ]);
  notifyPopup('notes-ready', session);
  showOsNotification({
    id: `note-ready-${meetingId}`,
    title: 'Clinical note ready',
    message: 'Your encounter note is ready. Open md telescribe to review it.',
  });
}

/**
 * Upload audio and generate SOAP notes on the server (runs after popup is shown).
 * @param {{ audioBuffer: ArrayBuffer, filename: string, visitModality?: 'AUDIO' | 'VIDEO' | 'IN_PERSON' }} payload
 */
async function processStoppedRecording(payload) {
  if (processingRecordingPromise) {
    return processingRecordingPromise;
  }

  processingRecordingPromise = runProcessStoppedRecording(payload).finally(() => {
    processingRecordingPromise = null;
  });

  return processingRecordingPromise;
}

/**
 * @param {{ audioBuffer: ArrayBuffer, micAudioBuffer?: ArrayBuffer | null, tabAudioBuffer?: ArrayBuffer | null, filename: string, visitModality?: 'AUDIO' | 'VIDEO' | 'IN_PERSON' }} payload
 */
async function runProcessStoppedRecording(payload) {
  const epoch = processingEpoch;
  let meetingId = null;
  let note = null;
  let visitModality = payload.visitModality;

  const isStale = async () => {
    if (epoch !== processingEpoch) {
      return true;
    }
    const { recording } = await chrome.storage.local.get('recording');
    return Boolean(recording);
  };

  try {
    await setProcessingStage('uploading');
    if (await isStale()) {
      return;
    }
    notifyPopup('sync-status', { stage: 'uploading' });

    await wakeBackend().catch(() => {});

    const { detectedVisitModality, pageVisitModality, forcedVisitModality, activeMeetingId } =
      await chrome.storage.session.get([
        'detectedVisitModality',
        'pageVisitModality',
        'forcedVisitModality',
        'activeMeetingId',
      ]);
    visitModality =
      forcedVisitModality === 'VIDEO' ||
      forcedVisitModality === 'AUDIO' ||
      forcedVisitModality === 'IN_PERSON'
        ? forcedVisitModality
        : resolveRecordingVisitModality({
            detectedVisitModality,
            pageVisitModality,
            stopSignal: payload.visitModality,
          });

    if (activeMeetingId) {
      meetingId = activeMeetingId;
    } else {
      const meeting = await createMeeting(
        payload.filename.replace(/\.webm$/, ''),
        visitModality,
      );
      meetingId = meeting.id;
      await chrome.storage.session.set({ activeMeetingId: meetingId });
    }
    if (await isStale()) {
      return;
    }
    await updatePendingSessionMeeting(meetingId, visitModality);

    // Let the final live Whisper chunk(s) finish before kicking note generation.
    await flushPendingLiveTranscripts();

    await setProcessingStage('generating');
    notifyPopup('sync-status', { stage: 'generating' });

    try {
      await completeMeeting(meetingId);
    } catch (err) {
      console.warn('[background] completeMeeting failed (will still generate):', err);
    }

    const uploadAudioPromise = (async () => {
      try {
        await uploadMeetingAudio(meetingId, payload.audioBuffer, 'mixed');
        console.log('[background] uploaded audio bytes:', payload.audioBuffer.byteLength);
      } catch (err) {
        console.warn('[background] mixed audio upload failed:', err);
      }

      const sideUploads = [];
      if (payload.micAudioBuffer && payload.micAudioBuffer.byteLength >= 1024) {
        sideUploads.push(uploadMeetingAudio(meetingId, payload.micAudioBuffer, 'mic'));
      }
      if (payload.tabAudioBuffer && payload.tabAudioBuffer.byteLength >= 1024) {
        sideUploads.push(uploadMeetingAudio(meetingId, payload.tabAudioBuffer, 'tab'));
      }
      if (sideUploads.length > 0) {
        await Promise.all(sideUploads).catch((err) => {
          console.warn('[background] side-channel audio upload failed:', err);
        });
      }
    })();

    // If live ASR already captured the visit, draft notes immediately from that
    // full conversation. Only wait on audio upload when we still need Whisper.
    let hasLiveTranscript = false;
    try {
      const meetingSnapshot = await getMeeting(meetingId);
      const segments = meetingSnapshot?.segments ?? meetingSnapshot?.transcriptSegments ?? [];
      const joined = Array.isArray(segments)
        ? segments.map((s) => (s?.text || '').trim()).filter(Boolean).join(' ')
        : '';
      hasLiveTranscript = joined.length >= 80;
    } catch (err) {
      console.warn('[background] could not check live transcript before generate:', err);
    }

    if (!hasLiveTranscript) {
      notifyPopup('sync-status', { stage: 'uploading' });
      await uploadAudioPromise;
      notifyPopup('sync-status', { stage: 'generating' });
    } else {
      void uploadAudioPromise;
    }

    const generatePromise = generateMeetingNotes(meetingId, visitModality);

    const generated = await generatePromise;
    note = generated.note;
    visitModality = generated.visitModality ?? visitModality;
    if (await isStale()) {
      return;
    }
    await finishNotesSession(meetingId, note, visitModality, payload.filename);
    await chrome.storage.session.remove('activeMeetingId');
  } catch (err) {
    if (await isStale()) {
      return;
    }

    const backendError = err instanceof Error ? err.message : String(err);
    const errorCode = err instanceof ApiClientError ? err.code : undefined;
    console.error('[background] processStoppedRecording failed:', err);

    if (meetingId && !note) {
      try {
        const recovered = await generateMeetingNotes(meetingId, visitModality);
        if (await isStale()) {
          return;
        }
        note = recovered.note;
        visitModality = recovered.visitModality ?? visitModality;
        await finishNotesSession(meetingId, note, visitModality, payload.filename);
        await chrome.storage.session.remove('activeMeetingId');
        return;
      } catch (recoverErr) {
        console.warn('[background] note recovery after error failed:', recoverErr);
      }
    }

    if (await isStale()) {
      return;
    }

    const session = {
      meetingId,
      note: null,
      notesSaved: false,
      processingNotes: false,
      files: buildSessionFilesMeta(),
      subscriptionRequired: errorCode === 'SUBSCRIPTION_REQUIRED',
      subscribeUrl: errorCode === 'SUBSCRIPTION_REQUIRED' ? getPricingUrl() : undefined,
    };

    await chrome.storage.local.set({
      pendingSession: session,
      processing: false,
      processingStage: null,
      syncError: backendError,
    });
    await stopProcessingAlarm();
    notifyPopup('processing-error', { error: backendError, session });
    showOsNotification({
      id: `note-failed-${Date.now()}`,
      title: 'Could not generate notes',
      message:
        typeof backendError === 'string'
          ? backendError.slice(0, 180)
          : 'Open md telescribe to retry or check your connection.',
    });
  }
}

/** Keep the service worker alive while notes are processing (MV3 can sleep mid-upload). */
const PROCESSING_ALARM = 'mdts-processing-keepalive';

async function startProcessingAlarm() {
  try {
    await chrome.alarms.create(PROCESSING_ALARM, { periodInMinutes: 0.5 });
  } catch (err) {
    console.warn('[background] processing alarm failed:', err);
  }
}

async function stopProcessingAlarm() {
  try {
    await chrome.alarms.clear(PROCESSING_ALARM);
  } catch {
    // ignore
  }
}

async function setProcessingStage(stage) {
  await chrome.storage.local.set({ processing: true, processingStage: stage });
  if (stage === 'uploading' || stage === 'generating' || stage === 'transcribing') {
    await startProcessingAlarm();
  }
}

/** Recover if the service worker restarted mid-upload (common when popup is closed). */
async function recoverInterruptedProcessing() {
  const { processing, pendingSession } = await chrome.storage.local.get([
    'processing',
    'pendingSession',
  ]);

  if (!processing || !pendingSession?.processingNotes || pendingSession?.note) {
    return;
  }

  if (pendingSession.meetingId) {
    try {
      await setProcessingStage('generating');
      // Resume generation — server may still be working, or the request never started.
      const recovered = await generateMeetingNotes(
        pendingSession.meetingId,
        pendingSession.visitModality,
      );
      await finishNotesSession(
        pendingSession.meetingId,
        recovered.note,
        recovered.visitModality ?? pendingSession.visitModality,
        pendingSession.files?.audioFilename || 'recording.webm',
      );
      await stopProcessingAlarm();
      return;
    } catch (err) {
      console.warn('[background] recoverInterruptedProcessing resume failed:', err);
      try {
        const polled = await pollMeetingNote(pendingSession.meetingId, {
          timeoutMs: 180_000,
          intervalMs: 2000,
        });
        await finishNotesSession(
          pendingSession.meetingId,
          polled.note,
          polled.visitModality ?? pendingSession.visitModality,
          pendingSession.files?.audioFilename || 'recording.webm',
        );
        await stopProcessingAlarm();
        return;
      } catch (pollErr) {
        console.warn('[background] recoverInterruptedProcessing poll failed:', pollErr);
      }
    }
  }

  const session = {
    ...pendingSession,
    processingNotes: false,
  };

  await stopProcessingAlarm();
  await chrome.storage.local.set({
    processing: false,
    processingStage: null,
    pendingSession: session,
    syncError:
      'Note generation was interrupted. Keep this popup open after stopping recording, and ensure you are online.',
  });
}

recoverInterruptedProcessing();

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== PROCESSING_ALARM) {
      return;
    }
    // Touch storage so MV3 keeps the worker alive while notes are generating.
    void chrome.storage.local.get(['processing', 'processingStage']).then((stored) => {
      if (!stored.processing) {
        void stopProcessingAlarm();
      }
    });
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'processing-keepalive') {
    port.onMessage.addListener(() => {});
    port.onDisconnect.addListener(() => {
      // Popup closed — alarm continues keeping the worker alive if still processing.
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'background') {
    return false;
  }

  const handle = async () => {
    switch (message.type) {
      case 'start-recording': {
        try {
          const forcedVisitModality =
            message.data?.forcedVisitModality === 'VIDEO'
              ? 'VIDEO'
              : message.data?.forcedVisitModality === 'AUDIO'
                ? 'AUDIO'
                : 'AUDIO';

          if (!message.data?.streamId || !message.data?.tabId) {
            return { ok: false, error: 'Missing tab capture stream. Focus a meeting tab and try again.' };
          }

          return await beginTabRecording({
            tabId: message.data.tabId,
            streamId: message.data.streamId,
            forcedVisitModality,
          });
        } catch (err) {
          await setRecordingState('idle');
          throw err;
        }
      }

      case 'start-recording-from-meeting': {
        return startRecordingFromMeeting(message.data || {}, _sender.tab?.id);
      }

      case 'open-extension-from-meeting': {
        return openExtensionFromMeeting(message.data || {}, _sender.tab?.id);
      }

      case 'get-recording-state': {
        const state = await getRecordingState();
        const { recording, recordingPaused } = await chrome.storage.local.get([
          'recording',
          'recordingPaused',
        ]);
        return {
          ok: true,
          recording: Boolean(recording) || state === 'recording' || state === 'paused',
          busy:
            state === 'starting' ||
            state === 'recording' ||
            state === 'paused' ||
            state === 'stopping',
          recordingPaused: Boolean(recordingPaused) || state === 'paused',
          recordingState: state,
        };
      }

      case 'open-extension-ui': {
        await openExtensionUi();
        return { ok: true };
      }

      case 'finish-meeting-launch': {
        await finishMeetingLaunch(message.data || {});
        return { ok: true };
      }

      case 'start-dictation': {
        pendingRecordingFiles = null;
        invalidateProcessing();

        const state = await getRecordingState();
        if (state === 'starting' || state === 'recording' || state === 'paused' || state === 'stopping') {
          return { ok: false, error: 'Recording is already in progress. Click Stop Recording first.' };
        }

        await setRecordingState('starting');

        try {
          await chrome.storage.session.set({
            recordingTabId: null,
            pageVisitModality: 'IN_PERSON',
            detectedVisitModality: 'IN_PERSON',
            forcedVisitModality: 'IN_PERSON',
          });

          await ensureOffscreenDocument();
          const result = await sendToOffscreen('start-dictation', {});

          if (result?.ok) {
            await setRecordingState('recording');
            await chrome.storage.session.set({
              detectedVisitModality: 'IN_PERSON',
              forcedVisitModality: 'IN_PERSON',
            });
            await chrome.storage.local.set({
              recording: true,
              recordingPaused: false,
              processing: false,
              syncError: null,
            });
            wakeBackend().catch(() => {});
            try {
              await ensureActiveMeeting('IN_PERSON');
            } catch (err) {
              console.warn('[background] early meeting create failed:', err);
            }
            return { ...result, visitModality: 'IN_PERSON' };
          }

          await setRecordingState('idle');
          return result;
        } catch (err) {
          await setRecordingState('idle');
          throw err;
        }
      }

      case 'pause-recording': {
        const state = await getRecordingState();
        if (state === 'paused') {
          await chrome.storage.local.set({ recording: true, recordingPaused: true });
          return { ok: true, paused: true };
        }
        if (state !== 'recording') {
          return { ok: false, error: 'Recording is not active.' };
        }

        const result = await sendToOffscreen('pause-recording');
        if (result?.ok) {
          await setRecordingState('paused');
          await chrome.storage.local.set({ recording: true, recordingPaused: true });
        }
        return result;
      }

      case 'resume-recording': {
        const state = await getRecordingState();
        if (state === 'recording') {
          await chrome.storage.local.set({ recording: true, recordingPaused: false });
          return { ok: true, paused: false };
        }
        if (state !== 'paused') {
          return { ok: false, error: 'Recording is not paused.' };
        }

        const result = await sendToOffscreen('resume-recording');
        if (result?.ok) {
          await setRecordingState('recording');
          await chrome.storage.local.set({ recording: true, recordingPaused: false });
        }
        return result;
      }

      case 'release-tab-capture': {
        await releaseTabCapture();
        return { ok: true };
      }

      case 'refresh-visit-modality': {
        const state = await getRecordingState();
        if (state !== 'recording' && state !== 'paused') {
          return { ok: false, error: 'Not recording' };
        }
        const result = await sendToOffscreen('get-visit-modality');
        if (result?.ok && result.visitModality) {
          await chrome.storage.session.set({ detectedVisitModality: result.visitModality });
        }
        return result;
      }

      case 'get-mic-level': {
        const state = await getRecordingState();
        if (state !== 'recording' && state !== 'paused') {
          return { ok: true, level: 0, bars: [0, 0, 0, 0, 0] };
        }
        try {
          const result = await sendToOffscreen('get-mic-level');
          return result?.ok
            ? result
            : { ok: true, level: 0, bars: [0, 0, 0, 0, 0] };
        } catch {
          return { ok: true, level: 0, bars: [0, 0, 0, 0, 0] };
        }
      }

      case 'mic-level': {
        notifyPopup('mic-level', message.data);
        return { ok: true };
      }

      case 'live-transcript-chunk': {
        return handleLiveTranscriptChunk(message.data || {});
      }

      case 'stop-recording': {
        const state = await getRecordingState();
        if (state === 'starting') {
          return { ok: false, error: 'Recording is still starting. Wait a moment and try again.' };
        }
        if (state !== 'recording' && state !== 'paused' && state !== 'stopping') {
          return { ok: false, error: 'No active recording to stop.' };
        }

        await setRecordingState('stopping');

        let result;
        let audioBuffer = null;
        let micAudioBuffer = null;
        let tabAudioBuffer = null;
        try {
          result = await sendToOffscreen('stop-recording');
          if (result?.ok) {
            audioBuffer = arrayBufferFromAudioResult(result);
            micAudioBuffer = result.micAudioDataUrl
              ? dataUrlToArrayBuffer(result.micAudioDataUrl)
              : null;
            tabAudioBuffer = result.tabAudioDataUrl
              ? dataUrlToArrayBuffer(result.tabAudioDataUrl)
              : null;
            if (!audioBuffer || audioBuffer.byteLength < 1024) {
              return {
                ok: false,
                error:
                  'Recording audio was empty or corrupted. Record for at least a few seconds and try again.',
              };
            }
          }
        } finally {
          try {
            await sendToOffscreen('force-cleanup');
          } catch {
            // ignore
          }
          await closeOffscreenDocument();
          await setRecordingState('idle');
          await chrome.storage.local.set({ recordingPaused: false });
        }

        if (!result?.ok) {
          await chrome.storage.local.set({ recording: false, recordingPaused: false, processing: false });
          return result;
        }

        pendingRecordingFiles = {
          audio: audioBuffer && result.filename
            ? { buffer: audioBuffer, filename: result.filename }
            : undefined,
          text: result.transcriptText && result.textFilename
            ? { text: result.transcriptText, filename: result.textFilename }
            : undefined,
        };

        const files = buildSessionFilesMeta();
        const initialSession = {
          meetingId: null,
          note: null,
          notesSaved: false,
          processingNotes: true,
          files,
        };

        await chrome.storage.local.set({
          recording: false,
          recordingPaused: false,
          processing: true,
          processingStage: 'uploading',
          pendingSession: initialSession,
        });

        notifyPopup('session-processing', { files });

        void processStoppedRecording({
          audioBuffer,
          micAudioBuffer,
          tabAudioBuffer,
          filename: result.filename,
          visitModality: result.visitModality,
        });

        return { ok: true, files, processing: true };
      }

      case 'download-recording-file': {
        const fileType = message.data?.fileType;

        if (fileType === 'text') {
          const resolved = await resolveTranscriptText();
          if (!resolved?.text || !resolved?.filename) {
            return {
              ok: false,
              error: 'Transcript is not ready yet. Wait for notes to finish generating.',
            };
          }

          if (isPlaceholderTranscript(resolved.text)) {
            return {
              ok: false,
              error: 'Transcript is empty. The server could not transcribe this recording.',
            };
          }

          return {
            ok: true,
            filename: resolved.filename,
            text: resolved.text,
            mimeType: 'text/plain;charset=utf-8',
          };
        }

        const file = pendingRecordingFiles?.audio;
        if (!file?.buffer || !file?.filename) {
          return { ok: false, error: 'Recording file is no longer available. Record again to download.' };
        }

        return {
          ok: true,
          filename: file.filename,
          audioBuffer: file.buffer,
          mimeType: 'audio/webm',
          saveAs: true,
        };
      }

      case 'has-recording-files': {
        return { ok: true, files: buildSessionFilesMeta() };
      }

      case 'open-offline-template': {
        try {
          const visitModality =
            message.data?.visitModality === 'AUDIO' ? 'AUDIO' : 'VIDEO';
          await wakeBackend().catch(() => {});
          const title =
            visitModality === 'AUDIO'
              ? `Offline Audio Template ${new Date().toISOString().slice(0, 10)}`
              : `Offline Video Template ${new Date().toISOString().slice(0, 10)}`;
          const meeting = await createMeeting(title, visitModality);
          return { ok: true, meetingId: meeting.id, visitModality };
        } catch (err) {
          if (err instanceof ApiClientError) {
            return { ok: false, error: err.message, code: err.code };
          }
          throw err;
        }
      }

      case 'save-note': {
        const { meetingId, title, summary, content } = message.data || {};
        if (!meetingId || !content) {
          return { ok: false, error: 'Meeting ID and note content are required.' };
        }

        const savedNote = await saveMeetingNote(meetingId, { title, summary, content });
        const stored = await chrome.storage.local.get('pendingSession');
        const session = {
          meetingId,
          note: savedNote,
          notesSaved: true,
          files: stored.pendingSession?.files ?? buildSessionFilesMeta(),
        };
        await chrome.storage.local.set({ pendingSession: session });
        return { ok: true, note: savedNote };
      }

      case 'retry-generate-notes': {
        const { meetingId, filename } = message.data || {};
        const stored = await chrome.storage.local.get('pendingSession');
        const resolvedMeetingId = meetingId || stored.pendingSession?.meetingId;
        const audio = pendingRecordingFiles?.audio;
        const visitModality = stored.pendingSession?.visitModality;

        if (!resolvedMeetingId) {
          if (!audio?.buffer) {
            return {
              ok: false,
              error: 'Cannot retry — record again and keep this popup open until notes appear.',
            };
          }

          await chrome.storage.local.set({ processing: true, processingStage: 'generating', syncError: null });
          void processStoppedRecording({ audioBuffer: audio.buffer, filename: filename || audio.filename });
          return { ok: true };
        }

        await chrome.storage.local.set({ processing: true, processingStage: 'generating', syncError: null });
        await startProcessingAlarm();
        try {
          const note = await generateMeetingNotes(resolvedMeetingId, visitModality);
          await finishNotesSession(
            resolvedMeetingId,
            note,
            visitModality,
            filename || audio?.filename || 'recording.webm',
          );
          return { ok: true, note };
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err);
          await stopProcessingAlarm();
          await chrome.storage.local.set({
            processing: false,
            processingStage: null,
            syncError: errorText,
          });
          return { ok: false, error: errorText };
        }
      }

      case 'poll-meeting-note': {
        const meetingId = message.data?.meetingId;
        if (!meetingId) {
          return { ok: false, error: 'Meeting ID is required.' };
        }

        try {
          const recovered = await pollMeetingNote(meetingId, {
            timeoutMs: message.data?.timeoutMs ?? 20_000,
            intervalMs: 2000,
          });
          const stored = await chrome.storage.local.get('pendingSession');
          const session = {
            ...(stored.pendingSession || {}),
            meetingId,
            note: recovered.note,
            visitModality: recovered.visitModality ?? stored.pendingSession?.visitModality,
            notesSaved: false,
            processingNotes: false,
            files: stored.pendingSession?.files ?? buildSessionFilesMeta(),
          };
          await chrome.storage.local.set({
            pendingSession: session,
            processing: false,
            processingStage: null,
            syncError: null,
          });
          notifyPopup('notes-ready', session);
          return { ok: true, note: recovered.note, visitModality: recovered.visitModality };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }

      case 'auth-login': {
        try {
          const data = await login(message.data || {});
          if (data?.requiresMfa && data?.mfaToken) {
            return {
              ok: false,
              code: 'MFA_REQUIRED',
              mfaToken: data.mfaToken,
              error: 'Enter the 6-digit code from your authenticator app.',
            };
          }
          if (!data?.accessToken) {
            return { ok: false, error: 'Sign in failed. No access token returned.' };
          }

          const session = await getExtensionSession();
          return { ok: true, data: session };
        } catch (err) {
          if (err instanceof ApiClientError) {
            return { ok: false, error: err.message, code: err.code };
          }
          throw err;
        }
      }

      case 'auth-verify-mfa': {
        try {
          await verifyMfaLogin({
            mfaToken: message.data?.mfaToken,
            code: message.data?.code,
          });
          const session = await getExtensionSession();
          return { ok: true, data: session };
        } catch (err) {
          if (err instanceof ApiClientError) {
            return { ok: false, error: err.message, code: err.code };
          }
          throw err;
        }
      }

      case 'auth-logout': {
        await logout();
        return { ok: true };
      }

      case 'auth-session': {
        try {
          const session = await getExtensionSession();
          return { ok: true, data: session };
        } catch (err) {
          // Only clear the stored token on real auth failures — not network/cold-start blips.
          if (isAuthFailure(err)) {
            await logout();
            return { ok: false, code: 'AUTH_REQUIRED' };
          }

          const cached = await getCachedAuthUiSession();
          if (cached?.user) {
            return { ok: true, data: cached, stale: true };
          }

          if (err instanceof ApiClientError) {
            return { ok: false, error: err.message, code: err.code };
          }
          throw err;
        }
      }

      case 'open-subscribe': {
        await chrome.tabs.create({ url: message.data?.url || getPricingUrl() });
        return { ok: true };
      }

      case 'clear-session': {
        pendingRecordingFiles = null;
        invalidateProcessing();
        await chrome.storage.local.remove(['pendingSession', 'syncError', 'processingStage']);
        await chrome.storage.local.set({ processing: false });
        return { ok: true };
      }

      default:
        return { ok: false, error: `Unknown message type: ${message.type}` };
    }
  };

  handle()
    .then(sendResponse)
    .catch((err) => {
      console.error('[background] message handler error:', err);
      const errorText = err instanceof Error ? err.message : String(err);
      notifyPopup('recording-error', errorText);
      sendResponse({ ok: false, error: errorText });
    });

  return true;
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.target === 'background' && message.type === 'offscreen-error') {
    notifyPopup('recording-error', message.data);
    chrome.storage.local.set({ recording: false, recordingPaused: false, processing: false });
    chrome.storage.session.set({ recordingState: 'idle' });
  }

  if (message.target === 'background' && message.type === 'mic-level') {
    notifyPopup('mic-level', message.data);
  }
});

if (chrome.notifications?.onClicked) {
  chrome.notifications.onClicked.addListener((notificationId) => {
    chrome.notifications.clear(notificationId).catch(() => {});
    void openExtensionUi();
  });
}

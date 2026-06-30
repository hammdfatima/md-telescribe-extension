/**
 * MV3 Service Worker — orchestrates the offscreen document and routes messages.
 */

importScripts('config.js', 'api.js', 'visit-modality.js');

const OFFSCREEN_URL = 'offscreen.html';

/** @type {{ audio?: { buffer: ArrayBuffer, filename: string }, text?: { text: string, filename: string } } | null} */
let pendingRecordingFiles = null;

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

async function setProcessingStage(stage) {
  await chrome.storage.local.set({ processingStage: stage });
}

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
  await setRecordingState('idle');
  await chrome.storage.local.set({ recording: false, processing: false });
}

/** @type {Promise<void> | null} */
let processingRecordingPromise = null;

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
}

/**
 * Upload audio and generate SOAP notes on the server (runs after popup is shown).
 * @param {{ audioBuffer: ArrayBuffer, filename: string, visitModality?: 'AUDIO' | 'VIDEO' }} payload
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
 * @param {{ audioBuffer: ArrayBuffer, micAudioBuffer?: ArrayBuffer | null, tabAudioBuffer?: ArrayBuffer | null, filename: string, visitModality?: 'AUDIO' | 'VIDEO' }} payload
 */
async function runProcessStoppedRecording(payload) {
  let meetingId = null;
  let note = null;
  let visitModality = payload.visitModality;

  try {
    await setProcessingStage('uploading');
    notifyPopup('sync-status', { stage: 'uploading' });

    await wakeBackend().catch(() => {});

    const { detectedVisitModality, pageVisitModality } = await chrome.storage.session.get([
      'detectedVisitModality',
      'pageVisitModality',
    ]);
    visitModality = resolveRecordingVisitModality({
      detectedVisitModality,
      pageVisitModality,
      stopSignal: payload.visitModality,
    });

    const meeting = await createMeeting(
      payload.filename.replace(/\.webm$/, ''),
      visitModality,
    );
    meetingId = meeting.id;
    await updatePendingSessionMeeting(meetingId, visitModality);

    await uploadMeetingAudio(meetingId, payload.audioBuffer, 'mixed');
    if (payload.micAudioBuffer && payload.micAudioBuffer.byteLength >= 1024) {
      await uploadMeetingAudio(meetingId, payload.micAudioBuffer, 'mic');
    }
    if (payload.tabAudioBuffer && payload.tabAudioBuffer.byteLength >= 1024) {
      await uploadMeetingAudio(meetingId, payload.tabAudioBuffer, 'tab');
    }
    console.log('[background] uploaded audio bytes:', payload.audioBuffer.byteLength);
    await completeMeeting(meetingId);

    await setProcessingStage('generating');
    notifyPopup('sync-status', { stage: 'generating' });

    note = await generateMeetingNotes(meetingId, visitModality);
    await finishNotesSession(meetingId, note, visitModality, payload.filename);
  } catch (err) {
    const backendError = err instanceof Error ? err.message : String(err);
    const errorCode = err instanceof ApiClientError ? err.code : undefined;
    console.error('[background] processStoppedRecording failed:', err);

    if (meetingId && !note) {
      try {
        note = await pollMeetingNote(meetingId, { timeoutMs: 45_000, intervalMs: 2000 });
        await finishNotesSession(meetingId, note, visitModality, payload.filename);
        return;
      } catch (recoverErr) {
        console.warn('[background] note recovery after error failed:', recoverErr);
      }
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
    notifyPopup('processing-error', { error: backendError, session });
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
      const note = await pollMeetingNote(pendingSession.meetingId, {
        timeoutMs: 60_000,
        intervalMs: 2000,
      });
      await finishNotesSession(
        pendingSession.meetingId,
        note,
        pendingSession.visitModality,
        pendingSession.files?.audioFilename || 'recording.webm',
      );
      return;
    } catch (err) {
      console.warn('[background] recoverInterruptedProcessing poll failed:', err);
    }
  }

  const session = {
    ...pendingSession,
    processingNotes: false,
  };

  await chrome.storage.local.set({
    processing: false,
    processingStage: null,
    pendingSession: session,
    syncError:
      'Note generation was interrupted. Keep this popup open after stopping recording, and ensure you are online.',
  });
}

recoverInterruptedProcessing();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'processing-keepalive') {
    port.onMessage.addListener(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'background') {
    return false;
  }

  const handle = async () => {
    switch (message.type) {
      case 'start-recording': {
        pendingRecordingFiles = null;

        const state = await getRecordingState();
        if (state === 'starting' || state === 'recording' || state === 'stopping') {
          return { ok: false, error: 'Recording is already in progress. Click Stop Recording first.' };
        }

        await setRecordingState('starting');

        try {
          const pageVisitModality = await detectVisitModalityFromTab(message.data?.tabId);
          await chrome.storage.session.set({
            recordingTabId: message.data?.tabId ?? null,
            pageVisitModality,
            detectedVisitModality: pageVisitModality,
          });

          await ensureOffscreenDocument();
          const result = await sendToOffscreen('start-recording', {
            ...message.data,
            pageVisitModality,
          });

          if (result?.ok) {
            await setRecordingState('recording');
            const detectedVisitModality = mergeVisitModality(
              pageVisitModality,
              result.visitModality,
            );
            await chrome.storage.session.set({
              detectedVisitModality,
            });
            await chrome.storage.local.set({ recording: true, processing: false, syncError: null });
            wakeBackend().catch(() => {});
          } else {
            await setRecordingState('idle');
          }

          if (result?.ok) {
            return {
              ...result,
              visitModality: mergeVisitModality(pageVisitModality, result.visitModality),
            };
          }

          return result;
        } catch (err) {
          await setRecordingState('idle');
          throw err;
        }
      }

      case 'release-tab-capture': {
        await releaseTabCapture();
        return { ok: true };
      }

      case 'refresh-visit-modality': {
        const state = await getRecordingState();
        if (state !== 'recording') {
          return { ok: false, error: 'Not recording' };
        }
        const result = await sendToOffscreen('get-visit-modality');
        if (result?.ok && result.visitModality) {
          await chrome.storage.session.set({ detectedVisitModality: result.visitModality });
        }
        return result;
      }

      case 'stop-recording': {
        const state = await getRecordingState();
        if (state === 'starting') {
          return { ok: false, error: 'Recording is still starting. Wait a moment and try again.' };
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
        }

        if (!result?.ok) {
          await chrome.storage.local.set({ recording: false, processing: false });
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
          const note = await pollMeetingNote(meetingId, {
            timeoutMs: message.data?.timeoutMs ?? 20_000,
            intervalMs: 2000,
          });
          const stored = await chrome.storage.local.get('pendingSession');
          const session = {
            ...(stored.pendingSession || {}),
            meetingId,
            note,
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
          return { ok: true, note };
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
          if (err instanceof ApiClientError && err.code === 'AUTH_REQUIRED') {
            return { ok: false, code: 'AUTH_REQUIRED' };
          }
          if (err instanceof ApiClientError) {
            await logout();
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
    chrome.storage.local.set({ recording: false, processing: false });
    chrome.storage.session.set({ recordingState: 'idle' });
  }
});

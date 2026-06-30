/**
 * Offscreen document — owns all live media objects for this extension.
 *
 * AUDIO MIXING GRAPH:
 *
 *   [Mic Stream] ──► micSource ──┬──► mixDestination ──► MediaRecorder (combined .webm)
 *                                 ├──► micOnlyDestination ──► micRecorder (transcript: Doctor)
 *   [Tab Stream] ──► tabSource ──┼──► mixDestination
 *                                 ├──► tabOnlyDestination ──► tabRecorder (transcript: Patient)
 *                                 └──► audioContext.destination (monitoring)
 *
 * CONVERSATION TRANSCRIPT:
 *   Mic and tab are transcribed separately with Whisper timestamps, then merged
 *   chronologically so the .txt reads like a two-party conversation.
 */

/** @type {MediaStream | null} */
let micStream = null;

/** @type {MediaStream | null} */
let tabStream = null;

/** @type {AudioContext | null} */
let audioContext = null;

/** @type {MediaRecorder | null} */
let mediaRecorder = null;

/** @type {MediaRecorder | null} */
let micRecorder = null;

/** @type {MediaRecorder | null} */
let tabRecorder = null;

/** @type {Blob[]} */
let recordedChunks = [];

/** @type {Blob[]} */
let micRecordedChunks = [];

/** @type {Blob[]} */
let tabRecordedChunks = [];

/** @type {MediaStreamAudioSourceNode | null} */
let micSourceNode = null;

/** @type {MediaStreamAudioSourceNode | null} */
let tabSourceNode = null;

/** @type {MediaStreamAudioDestinationNode | null} */
let mixDestination = null;

/** @type {MediaStreamAudioDestinationNode | null} */
let micOnlyDestination = null;

/** @type {MediaStreamAudioDestinationNode | null} */
let tabOnlyDestination = null;

let isRecording = false;

/** @type {ReturnType<typeof setInterval> | null} */
let tabVideoSampleTimer = null;

/** @type {HTMLVideoElement | null} */
let tabVideoSamplerEl = null;

/** @type {Uint8ClampedArray | null} */
let lastTabFrameData = null;

/** @type {{ pageHint: 'AUDIO' | 'VIDEO' | null, tabSamples: number, tabVideoHits: number }} */
let visitModalityState = {
  pageHint: null,
  tabSamples: 0,
  tabVideoHits: 0,
};

/** Cached Whisper pipeline (downloaded once, ~40 MB first run). */
let whisperPipeline = null;

const MIME_TYPE = 'audio/webm;codecs=opus';
// Two-person conversation: mic = doctor, tab/call audio = patient.
const SPEAKER_DOCTOR = 'Doctor';
const SPEAKER_PATIENT = 'Patient';

/**
 * Report an error to the background script for popup display.
 * @param {string} text
 */
function reportError(text) {
  chrome.runtime
    .sendMessage({ type: 'offscreen-error', target: 'background', data: text })
    .catch(() => {});
}

/**
 * @param {number} seconds
 */
function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Lazy-load the Whisper ASR pipeline.
 */
async function getWhisperPipeline() {
  if (whisperPipeline) {
    return whisperPipeline;
  }

  const { pipeline, env } = await import('./lib/transformers.min.js');

  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.wasmPaths =
    'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/';
  env.allowLocalModels = false;
  env.useBrowserCache = true;

  whisperPipeline = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
  return whisperPipeline;
}

/**
 * Transcribe one stream blob and return timestamped segments tagged with a speaker.
 * @param {Blob} blob
 * @param {string} speaker
 * @returns {Promise<Array<{ speaker: string, start: number, text: string }>>}
 */
async function transcribeStreamToSegments(blob, speaker) {
  if (!blob || blob.size < 100) {
    return [];
  }

  const transcriber = await getWhisperPipeline();
  const url = URL.createObjectURL(blob);

  try {
    const result = await transcriber(url, {
      return_timestamps: true,
      chunk_length_s: 30,
    });

    const chunks = result?.chunks || [];
    return chunks
      .map((chunk) => ({
        speaker,
        start: Array.isArray(chunk.timestamp) ? chunk.timestamp[0] : 0,
        text: (chunk.text || '').trim(),
      }))
      .filter((chunk) => chunk.text.length > 0);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Build a chronological timeline from mic + tab segments.
 * @param {Array<{ speaker: string, start: number, text: string }>} micSegments
 * @param {Array<{ speaker: string, start: number, text: string }>} tabSegments
 */
function buildConversationTimeline(micSegments, tabSegments) {
  return [...micSegments, ...tabSegments].sort((a, b) => a.start - b.start);
}

/**
 * Merge mic + tab segments into chronological conversation lines.
 * @param {Array<{ speaker: string, start: number, text: string }>} timeline
 */
function formatConversationText(timeline) {
  if (timeline.length === 0) {
    return '';
  }

  return timeline
    .map((segment) => `[${formatTimestamp(segment.start)}] ${segment.speaker}: ${segment.text}`)
    .join('\n\n');
}

/**
 * Map timeline segments to the API transcript shape.
 * @param {Array<{ speaker: string, start: number, text: string }>} timeline
 */
function toApiSegments(timeline) {
  return timeline.map((segment) => ({
    text: segment.text,
    speaker: segment.speaker,
    startMs: Math.round(segment.start * 1000),
    isFinal: true,
  }));
}

/**
 * Transcribe mic and tab recordings separately, then build a conversation transcript.
 * @param {Blob} micBlob
 * @param {Blob} tabBlob
 * @returns {Promise<{ conversation: string, segments: Array<{ text: string, speaker: string, startMs: number, isFinal: boolean }> }>}
 */
async function transcribeConversation(micBlob, tabBlob) {
  try {
    const [micSegments, tabSegments] = await Promise.all([
      transcribeStreamToSegments(micBlob, SPEAKER_DOCTOR),
      transcribeStreamToSegments(tabBlob, SPEAKER_PATIENT),
    ]);
    const timeline = buildConversationTimeline(micSegments, tabSegments);
    return {
      conversation: formatConversationText(timeline),
      segments: toApiSegments(timeline),
    };
  } catch (err) {
    console.warn('[offscreen] Conversation transcription failed:', err);
    return { conversation: '', segments: [] };
  }
}

/**
 * @param {string} conversation
 * @param {string} timestamp
 */
function formatTranscriptFile(conversation, timestamp) {
  const header = `Tab + Mic Recorder — 2-Person Conversation\nRecorded: ${timestamp}\n`;
  const legend = `Speakers: ${SPEAKER_DOCTOR} = microphone | ${SPEAKER_PATIENT} = call/tab audio\n${'='.repeat(50)}\n\n`;
  const body = conversation || '(Transcript is being generated on the server.)';
  const footer =
    '\n\n---\nTranscript generated on the server after upload.';
  return header + legend + body + footer;
}

/**
 * Wire ondataavailable for a MediaRecorder into a chunk array.
 * @param {MediaRecorder} recorder
 * @param {Blob[]} chunks
 */
function attachChunkCollector(recorder, chunks) {
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  };
}

/**
 * Stop a MediaRecorder and resolve with a WebM blob.
 * @param {MediaRecorder | null} recorder
 * @param {Blob[]} chunks
 * @param {string} mimeType
 */
function finalizeRecorder(recorder, chunks, mimeType) {
  if (!recorder || recorder.state === 'inactive') {
    return Promise.resolve(new Blob(chunks, { type: mimeType }));
  }

  return new Promise((resolve) => {
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: mimeType }));
    };

    try {
      if (recorder.state === 'recording') {
        recorder.requestData();
      }
      recorder.stop();
    } catch {
      resolve(new Blob(chunks, { type: mimeType }));
    }
  });
}

/**
 * Stop all tracks, disconnect nodes, and close the AudioContext.
 */
async function cleanup() {
  mediaRecorder = null;
  micRecorder = null;
  tabRecorder = null;
  recordedChunks = [];
  micRecordedChunks = [];
  tabRecordedChunks = [];

  if (micSourceNode) {
    try {
      micSourceNode.disconnect();
    } catch {
      // ignore
    }
    micSourceNode = null;
  }

  if (tabSourceNode) {
    try {
      tabSourceNode.disconnect();
    } catch {
      // ignore
    }
    tabSourceNode = null;
  }

  mixDestination = null;
  micOnlyDestination = null;
  tabOnlyDestination = null;

  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }

  if (tabStream) {
    tabStream.getTracks().forEach((track) => track.stop());
    tabStream = null;
  }

  stopTabVideoSampling();
  resetVisitModalityState();

  if (audioContext) {
    try {
      await audioContext.close();
    } catch {
      // ignore
    }
    audioContext = null;
  }

  isRecording = false;
}

/**
 * Request microphone access. Surfaces permission-denied errors clearly.
 */
async function getMicrophoneStream() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const name = err instanceof DOMException ? err.name : 'Error';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      throw new Error(
        'Microphone permission denied in the recorder. Close and reopen the extension popup, ' +
          'click Start Recording, then Allow in the Chrome dialog.'
      );
    }
    if (name === 'NotFoundError') {
      throw new Error('No microphone found. Connect a mic and try again.');
    }
    if (name === 'NotReadableError') {
      throw new Error('Microphone is in use by another app. Close other apps and try again.');
    }
    throw new Error(`Microphone error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Redeem a tabCapture stream ID for tab audio (and optional video for visit detection).
 * @param {string} streamId
 */
async function getTabCaptureStream(streamId) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });
  } catch (firstErr) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        },
        video: false,
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : 'Error';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        throw new Error(
          'Tab audio capture was denied. The tab may be restricted or capture was blocked.',
        );
      }
      throw new Error(
        `Tab capture error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function resetVisitModalityState(pageHint = null) {
  visitModalityState = {
    pageHint: pageHint === 'VIDEO' ? 'VIDEO' : pageHint === 'AUDIO' ? 'AUDIO' : null,
    tabSamples: 0,
    tabVideoHits: 0,
  };
  lastTabFrameData = null;
}

function stopTabVideoSampling() {
  if (tabVideoSampleTimer) {
    clearInterval(tabVideoSampleTimer);
    tabVideoSampleTimer = null;
  }

  if (tabVideoSamplerEl) {
    tabVideoSamplerEl.pause();
    tabVideoSamplerEl.srcObject = null;
    tabVideoSamplerEl = null;
  }

  lastTabFrameData = null;
}

/**
 * Sample tab video frames during recording to detect visible camera content.
 * @param {MediaStreamTrack} videoTrack
 */
function startTabVideoSampling(videoTrack) {
  stopTabVideoSampling();

  if (!videoTrack || videoTrack.readyState === 'ended') {
    return;
  }

  const stream = new MediaStream([videoTrack]);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  video.play().catch(() => {});

  const canvas = document.createElement('canvas');
  canvas.width = 80;
  canvas.height = 60;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return;
  }

  tabVideoSamplerEl = video;

  tabVideoSampleTimer = setInterval(() => {
    if (!isRecording || video.readyState < 2) {
      return;
    }

    if (video.videoWidth < 32 || video.videoHeight < 32) {
      return;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = frame.data;
    const pixelCount = canvas.width * canvas.height;

    let brightness = 0;
    let diff = 0;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      brightness += r + g + b;

      if (lastTabFrameData) {
        diff +=
          Math.abs(r - lastTabFrameData[i]) +
          Math.abs(g - lastTabFrameData[i + 1]) +
          Math.abs(b - lastTabFrameData[i + 2]);
      }
    }

    lastTabFrameData = new Uint8ClampedArray(data);
    visitModalityState.tabSamples += 1;

    const avgBrightness = brightness / (pixelCount * 3);
    const avgDiff = diff / (pixelCount * 3);

    // Active video tiles change between frames; static camera feeds stay bright but stable.
    if (avgBrightness > 18 && (avgDiff > 2.5 || avgBrightness > 28)) {
      visitModalityState.tabVideoHits += 1;
    }
  }, 2000);
}

function resolveVisitModality() {
  if (visitModalityState.pageHint === 'VIDEO') {
    return 'VIDEO';
  }

  if (visitModalityState.tabSamples >= 1 && visitModalityState.tabVideoHits >= 1) {
    return 'VIDEO';
  }

  if (visitModalityState.tabVideoHits > 0) {
    return 'VIDEO';
  }

  if (visitModalityState.pageHint === 'AUDIO') {
    return 'AUDIO';
  }

  return 'AUDIO';
}

/**
 * Build the Web Audio mixing graph and start recorders on mixed + per-source streams.
 * @param {{ streamId: string }} payload
 */
async function startRecording(payload) {
  if (isRecording) {
    return { ok: false, error: 'Recording is already in progress.' };
  }

  const { streamId, pageVisitModality } = payload || {};
  if (!streamId) {
    return { ok: false, error: 'Missing tab capture stream ID.' };
  }

  try {
    micStream = await getMicrophoneStream();
    tabStream = await getTabCaptureStream(streamId);

    const tabVideoTrack = tabStream.getVideoTracks()[0] ?? null;
    const tabCapturesVideo =
      tabVideoTrack &&
      tabVideoTrack.readyState !== 'ended' &&
      tabVideoTrack.enabled !== false;

    // Tab capture includes video — don't lock to early page DOM "audio" (Meet/Zoom timing).
    const pageHint =
      pageVisitModality === 'VIDEO'
        ? 'VIDEO'
        : tabCapturesVideo
          ? null
          : pageVisitModality ?? null;
    resetVisitModalityState(pageHint);

    if (tabVideoTrack) {
      startTabVideoSampling(tabVideoTrack);
    }

    if (!MediaRecorder.isTypeSupported(MIME_TYPE)) {
      throw new Error(`MediaRecorder does not support ${MIME_TYPE} on this browser.`);
    }

    audioContext = new AudioContext();
    mixDestination = audioContext.createMediaStreamDestination();
    micOnlyDestination = audioContext.createMediaStreamDestination();
    tabOnlyDestination = audioContext.createMediaStreamDestination();

    micSourceNode = audioContext.createMediaStreamSource(micStream);
    tabSourceNode = audioContext.createMediaStreamSource(tabStream);

    // Combined recording (saved .webm).
    micSourceNode.connect(mixDestination);
    tabSourceNode.connect(mixDestination);

    // Per-source recordings for separate transcription.
    micSourceNode.connect(micOnlyDestination);
    tabSourceNode.connect(tabOnlyDestination);

    // Restore tab monitoring (tabCapture mutes normal output).
    tabSourceNode.connect(audioContext.destination);

    recordedChunks = [];
    micRecordedChunks = [];
    tabRecordedChunks = [];

    mediaRecorder = new MediaRecorder(mixDestination.stream, { mimeType: MIME_TYPE });
    micRecorder = new MediaRecorder(micOnlyDestination.stream, { mimeType: MIME_TYPE });
    tabRecorder = new MediaRecorder(tabOnlyDestination.stream, { mimeType: MIME_TYPE });

    attachChunkCollector(mediaRecorder, recordedChunks);
    attachChunkCollector(micRecorder, micRecordedChunks);
    attachChunkCollector(tabRecorder, tabRecordedChunks);

    mediaRecorder.onerror = (event) => {
      console.error('[offscreen] Mixed MediaRecorder error:', event);
      reportError('MediaRecorder encountered an error during recording.');
    };

    const timesliceMs = 1000;
    mediaRecorder.start(timesliceMs);
    micRecorder.start(timesliceMs);
    tabRecorder.start(timesliceMs);
    isRecording = true;

    return { ok: true, visitModality: resolveVisitModality() };
  } catch (err) {
    await cleanup();
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Read a Blob as a data URL so the service worker can call chrome.downloads.
 * @param {Blob} blob
 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Stop recording and return audio immediately — transcription runs on the server.
 */
async function stopRecording() {
  if (!isRecording || !mediaRecorder) {
    await cleanup();
    return { ok: false, error: 'No active recording to stop.' };
  }

  try {
    const mixedBlob = await finalizeRecorder(mediaRecorder, recordedChunks, MIME_TYPE);
    const micBlob =
      micRecordedChunks.length > 0
        ? await finalizeRecorder(micRecorder, micRecordedChunks, MIME_TYPE)
        : null;
    const tabBlob =
      tabRecordedChunks.length > 0
        ? await finalizeRecorder(tabRecorder, tabRecordedChunks, MIME_TYPE)
        : null;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `recording-${timestamp}.webm`;
    const textFilename = `recording-${timestamp}.txt`;
    const transcriptText = formatTranscriptFile('', timestamp);
    const audioDataUrl = await blobToDataUrl(mixedBlob);
    const micAudioDataUrl = micBlob ? await blobToDataUrl(micBlob) : null;
    const tabAudioDataUrl = tabBlob ? await blobToDataUrl(tabBlob) : null;
    const visitModality = resolveVisitModality();

    await cleanup();
    return {
      ok: true,
      filename,
      audioDataUrl,
      micAudioDataUrl,
      tabAudioDataUrl,
      textFilename,
      transcriptText,
      segments: [],
      conversation: '',
      visitModality,
    };
  } catch (err) {
    await cleanup();
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen') {
    return false;
  }

  const handle = async () => {
    switch (message.type) {
      case 'start-recording':
        return startRecording(message.data);
      case 'force-cleanup':
        await cleanup();
        return { ok: true };
      case 'stop-recording':
        return stopRecording();
      case 'get-visit-modality':
        return { ok: true, visitModality: resolveVisitModality() };
      default:
        return { ok: false, error: `Unknown offscreen message: ${message.type}` };
    }
  };

  handle()
    .then(sendResponse)
    .catch(async (err) => {
      await cleanup();
      const message = err instanceof Error ? err.message : String(err);
      sendResponse({ ok: false, error: message });
    });

  return true;
});

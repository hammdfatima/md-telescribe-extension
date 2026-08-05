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

/** Live ASR recorder — restarted on an interval so each blob is a valid WebM for Whisper. */
/** @type {MediaRecorder | null} */
let liveRecorder = null;

/** @type {Blob[]} */
let liveRecordedChunks = [];

/** @type {ReturnType<typeof setTimeout> | null} */
let liveChunkTimer = null;

/** @type {MediaStream | null} */
let liveChunkStream = null;

let liveChunkSeq = 0;

/** Seconds of audio per live Whisper request (shorter = faster notes after stop). */
const LIVE_CHUNK_MS = 12_000;

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
let isPaused = false;

/** @type {ReturnType<typeof setInterval> | null} */
let tabVideoSampleTimer = null;

/** @type {HTMLVideoElement | null} */
let tabVideoSamplerEl = null;

/** @type {Uint8ClampedArray | null} */
let lastTabFrameData = null;

/** @type {{ pageHint: 'AUDIO' | 'VIDEO' | null, forced: 'AUDIO' | 'VIDEO' | null, tabSamples: number, tabVideoHits: number }} */
let visitModalityState = {
  pageHint: null,
  forced: null,
  tabSamples: 0,
  tabVideoHits: 0,
};

/** Cached Whisper pipeline (downloaded once, ~40 MB first run). */
let whisperPipeline = null;

/** @type {AnalyserNode | null} */
let micAnalyser = null;

/** @type {ReturnType<typeof setInterval> | null} */
let micLevelTimer = null;

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
 * Report live microphone level bars to the popup visualizer.
 * @param {{ level: number, bars: number[] }} payload
 */
/** @type {{ level: number, bars: number[] }} */
let latestMicLevel = { level: 0, bars: [0, 0, 0, 0, 0] };

function reportMicLevel(payload) {
  latestMicLevel = payload;
  chrome.runtime
    .sendMessage({ type: 'mic-level', target: 'background', data: payload })
    .catch(() => {});
}

/**
 * Start sampling mic amplitude for the popup level meter.
 * @param {AudioNode} sourceNode
 */
function startMicLevelMeter(sourceNode) {
  stopMicLevelMeter();
  if (!audioContext || !sourceNode) {
    return;
  }

  micAnalyser = audioContext.createAnalyser();
  micAnalyser.fftSize = 512;
  micAnalyser.minDecibels = -90;
  micAnalyser.maxDecibels = -10;
  micAnalyser.smoothingTimeConstant = 0.5;
  sourceNode.connect(micAnalyser);

  const timeData = new Uint8Array(micAnalyser.fftSize);
  const freqData = new Uint8Array(micAnalyser.frequencyBinCount);
  const barCount = 5;

  const sampleLevels = () => {
    if (!micAnalyser || !isRecording) {
      return;
    }

    if (isPaused) {
      reportMicLevel({ level: 0, bars: Array(barCount).fill(0) });
      return;
    }

    micAnalyser.getByteTimeDomainData(timeData);
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < timeData.length; i += 1) {
      const sample = (timeData[i] - 128) / 128;
      const abs = Math.abs(sample);
      peak = Math.max(peak, abs);
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / timeData.length);
    // Aggressive boost so normal speaking clearly moves the bars.
    const level = Math.min(1, Math.max(rms * 8, peak * 3.2));

    micAnalyser.getByteFrequencyData(freqData);
    const bars = [];
    const bandSize = Math.max(1, Math.floor(freqData.length / barCount));
    for (let i = 0; i < barCount; i += 1) {
      let bandPeak = 0;
      const start = i * bandSize;
      const end = Math.min(freqData.length, start + bandSize);
      for (let j = start; j < end; j += 1) {
        bandPeak = Math.max(bandPeak, freqData[j]);
      }
      const freqLevel = bandPeak / 255;
      const barLevel = Math.min(1, Math.max(level * (0.55 + i * 0.1), freqLevel * 1.35));
      bars.push(barLevel);
    }

    reportMicLevel({ level, bars });
  };

  // Sample immediately so the first poll is not empty.
  sampleLevels();
  micLevelTimer = setInterval(sampleLevels, 50);
}

function stopMicLevelMeter() {
  if (micLevelTimer) {
    clearInterval(micLevelTimer);
    micLevelTimer = null;
  }

  if (micAnalyser) {
    try {
      micAnalyser.disconnect();
    } catch {
      // ignore
    }
    micAnalyser = null;
  }

  latestMicLevel = { level: 0, bars: [0, 0, 0, 0, 0] };
}

function getMicLevel() {
  return { ok: true, ...latestMicLevel };
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
 * Send a completed live WebM segment to the service worker for server Whisper.
 * @param {Blob} blob
 */
async function emitLiveTranscriptChunk(blob) {
  if (!blob || blob.size < 8 * 1024) {
    return;
  }

  liveChunkSeq += 1;
  const seq = liveChunkSeq;
  try {
    const audioDataUrl = await blobToDataUrl(blob);
    await chrome.runtime.sendMessage({
      target: 'background',
      type: 'live-transcript-chunk',
      data: { audioDataUrl, seq },
    });
  } catch (err) {
    console.warn('[offscreen] live transcript chunk send failed:', err);
  }
}

/**
 * Start (or restart) the rolling live ASR MediaRecorder on the mixed stream.
 * @param {MediaStream} stream
 */
function startLiveChunkCycle(stream) {
  if (!stream || !isRecording || isPaused) {
    return;
  }

  stopLiveChunkTimer();
  liveChunkStream = stream;
  liveRecordedChunks = [];

  try {
    liveRecorder = new MediaRecorder(stream, {
      mimeType: MIME_TYPE,
      audioBitsPerSecond: 128000,
    });
  } catch (err) {
    console.warn('[offscreen] live ASR recorder unavailable:', err);
    liveRecorder = null;
    return;
  }

  attachChunkCollector(liveRecorder, liveRecordedChunks);
  liveRecorder.start(1000);
  liveChunkTimer = setTimeout(() => {
    void rotateLiveChunk({ final: false });
  }, LIVE_CHUNK_MS);
}

function stopLiveChunkTimer() {
  if (liveChunkTimer) {
    clearTimeout(liveChunkTimer);
    liveChunkTimer = null;
  }
}

/**
 * Finalize the current live segment and optionally start the next one.
 * @param {{ final?: boolean }} [options]
 */
async function rotateLiveChunk(options = {}) {
  const final = Boolean(options.final);
  stopLiveChunkTimer();

  const recorder = liveRecorder;
  const chunks = liveRecordedChunks;
  const stream = liveChunkStream;
  liveRecorder = null;
  liveRecordedChunks = [];

  let blob = null;
  if (recorder || chunks.length > 0) {
    blob = await finalizeRecorder(recorder, chunks, MIME_TYPE);
  }

  if (!final && isRecording && !isPaused && stream) {
    startLiveChunkCycle(stream);
  }

  if (blob) {
    await emitLiveTranscriptChunk(blob);
  }
}

async function stopLiveChunkCapture() {
  stopLiveChunkTimer();
  liveChunkStream = null;
  if (liveRecorder || liveRecordedChunks.length > 0) {
    await rotateLiveChunk({ final: true });
  } else {
    liveRecorder = null;
    liveRecordedChunks = [];
  }
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
      if (recorder.state === 'recording' || recorder.state === 'paused') {
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
  stopMicLevelMeter();
  stopLiveChunkTimer();
  liveRecorder = null;
  liveRecordedChunks = [];
  liveChunkStream = null;

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
  isPaused = false;
}

/**
 * Request microphone access with constraints tuned for clinical speech.
 * Records doctor audio clearly while tab audio is monitored for the call.
 */
async function getMicrophoneStream() {
  const audioConstraints = {
    channelCount: 1,
    echoCancellation: true,
    // Noise suppression often eats medical speech; prefer auto-gain instead.
    noiseSuppression: false,
    autoGainControl: true,
  };

  try {
    return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  } catch (err) {
    // Fall back to default constraints if the browser rejects advanced options.
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (fallbackErr) {
      const name = fallbackErr instanceof DOMException ? fallbackErr.name : 'Error';
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
      throw new Error(
        `Microphone error: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`
      );
    }
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
  const normalizedHint =
    pageHint === 'VIDEO' || pageHint === 'AUDIO' || pageHint === 'IN_PERSON'
      ? pageHint
      : null;
  visitModalityState = {
    pageHint: normalizedHint,
    forced: normalizedHint === 'IN_PERSON' ? 'IN_PERSON' : null,
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
    if (!isRecording || isPaused || video.readyState < 2) {
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
  if (
    visitModalityState.forced === 'VIDEO' ||
    visitModalityState.forced === 'AUDIO' ||
    visitModalityState.forced === 'IN_PERSON'
  ) {
    return visitModalityState.forced;
  }

  if (visitModalityState.pageHint === 'IN_PERSON') {
    return 'IN_PERSON';
  }

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
 * @param {{ streamId: string, pageVisitModality?: 'AUDIO' | 'VIDEO' | null }} payload
 */
async function startRecording(payload) {
  if (isRecording) {
    return { ok: false, error: 'Recording is already in progress.' };
  }

  const { streamId, pageVisitModality, forcedVisitModality } = payload || {};
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

    // Prefer clinician-selected visit type when provided.
    const forced =
      forcedVisitModality === 'VIDEO' || forcedVisitModality === 'AUDIO'
        ? forcedVisitModality
        : null;
    const pageHint =
      forced ??
      (pageVisitModality === 'VIDEO'
        ? 'VIDEO'
        : tabCapturesVideo
          ? null
          : pageVisitModality ?? null);
    resetVisitModalityState(pageHint);
    if (forced) {
      visitModalityState.forced = forced;
    }

    if (tabVideoTrack && !forced) {
      startTabVideoSampling(tabVideoTrack);
    } else if (tabVideoTrack && forced === 'VIDEO') {
      // Keep sampling optional for diagnostics, but forced VIDEO wins at resolve time.
      startTabVideoSampling(tabVideoTrack);
    }

    if (!MediaRecorder.isTypeSupported(MIME_TYPE)) {
      throw new Error(`MediaRecorder does not support ${MIME_TYPE} on this browser.`);
    }

    audioContext = new AudioContext();
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    mixDestination = audioContext.createMediaStreamDestination();
    micOnlyDestination = audioContext.createMediaStreamDestination();
    tabOnlyDestination = audioContext.createMediaStreamDestination();

    micSourceNode = audioContext.createMediaStreamSource(micStream);
    tabSourceNode = audioContext.createMediaStreamSource(tabStream);

    // Boost doctor mic slightly before mix/monitor paths.
    const micGainNode = audioContext.createGain();
    micGainNode.gain.value = 2.0;
    micSourceNode.connect(micGainNode);

    // Soften tab monitor volume so echo cancellation is less likely to erase the doctor's voice.
    const tabMonitorGain = audioContext.createGain();
    tabMonitorGain.gain.value = 0.85;
    tabSourceNode.connect(tabMonitorGain);

    // Combined recording (saved .webm).
    micGainNode.connect(mixDestination);
    tabSourceNode.connect(mixDestination);

    // Per-source recordings for separate transcription.
    // Doctor track: record the raw mic MediaStream (higher fidelity than Web Audio destination).
    micGainNode.connect(micOnlyDestination);
    tabSourceNode.connect(tabOnlyDestination);

    // Restore tab monitoring (tabCapture mutes normal output).
    tabMonitorGain.connect(audioContext.destination);

    recordedChunks = [];
    micRecordedChunks = [];
    tabRecordedChunks = [];

    const recorderOptions = { mimeType: MIME_TYPE, audioBitsPerSecond: 128000 };
    mediaRecorder = new MediaRecorder(mixDestination.stream, recorderOptions);
    // Prefer raw mic tracks for doctor ASR accuracy.
    try {
      micRecorder = new MediaRecorder(micStream, recorderOptions);
    } catch {
      micRecorder = new MediaRecorder(micOnlyDestination.stream, recorderOptions);
    }
    tabRecorder = new MediaRecorder(tabOnlyDestination.stream, recorderOptions);

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
    isPaused = false;
    startMicLevelMeter(micGainNode);
    startLiveChunkCycle(mixDestination.stream);

    return { ok: true, visitModality: resolveVisitModality() };
  } catch (err) {
    await cleanup();
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Mic-only recording for in-person / face-to-face visits (no tab capture).
 */
async function startDictationRecording() {
  if (isRecording) {
    return { ok: false, error: 'Recording is already in progress.' };
  }

  try {
    micStream = await getMicrophoneStream();
    resetVisitModalityState('IN_PERSON');

    if (!MediaRecorder.isTypeSupported(MIME_TYPE)) {
      throw new Error(`MediaRecorder does not support ${MIME_TYPE} on this browser.`);
    }

    audioContext = new AudioContext();
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    mixDestination = audioContext.createMediaStreamDestination();
    micOnlyDestination = audioContext.createMediaStreamDestination();

    micSourceNode = audioContext.createMediaStreamSource(micStream);
    const micGainNode = audioContext.createGain();
    micGainNode.gain.value = 2.0;
    micSourceNode.connect(micGainNode);
    micGainNode.connect(mixDestination);
    micGainNode.connect(micOnlyDestination);

    recordedChunks = [];
    micRecordedChunks = [];
    tabRecordedChunks = [];

    const recorderOptions = { mimeType: MIME_TYPE, audioBitsPerSecond: 128000 };
    mediaRecorder = new MediaRecorder(mixDestination.stream, recorderOptions);
    try {
      micRecorder = new MediaRecorder(micStream, recorderOptions);
    } catch {
      micRecorder = new MediaRecorder(micOnlyDestination.stream, recorderOptions);
    }
    tabRecorder = null;

    attachChunkCollector(mediaRecorder, recordedChunks);
    attachChunkCollector(micRecorder, micRecordedChunks);

    mediaRecorder.onerror = (event) => {
      console.error('[offscreen] In-person MediaRecorder error:', event);
      reportError('MediaRecorder encountered an error during in-person recording.');
    };

    const timesliceMs = 1000;
    mediaRecorder.start(timesliceMs);
    micRecorder.start(timesliceMs);

    isRecording = true;
    isPaused = false;
    startMicLevelMeter(micGainNode);
    startLiveChunkCycle(mixDestination.stream);

    return { ok: true, visitModality: 'IN_PERSON', dictation: true };
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
 * Pause all active MediaRecorders without releasing mic/tab streams.
 */
async function pauseRecording() {
  if (!isRecording) {
    return { ok: false, error: 'No active recording to pause.' };
  }
  if (isPaused) {
    return { ok: true, paused: true };
  }

  const recorders = [mediaRecorder, micRecorder, tabRecorder, liveRecorder];
  for (const recorder of recorders) {
    if (recorder?.state === 'recording') {
      recorder.pause();
    }
  }

  // Keep AudioContext running so tab monitoring still plays the call.
  stopLiveChunkTimer();
  isPaused = true;
  return { ok: true, paused: true };
}

/**
 * Resume all paused MediaRecorders.
 */
async function resumeRecording() {
  if (!isRecording) {
    return { ok: false, error: 'No active recording to resume.' };
  }
  if (!isPaused) {
    return { ok: true, paused: false };
  }

  const recorders = [mediaRecorder, micRecorder, tabRecorder, liveRecorder];
  for (const recorder of recorders) {
    if (recorder?.state === 'paused') {
      recorder.resume();
    }
  }

  isPaused = false;
  if (liveChunkStream && (!liveRecorder || liveRecorder.state === 'inactive')) {
    startLiveChunkCycle(liveChunkStream);
  } else if (liveRecorder?.state === 'recording') {
    liveChunkTimer = setTimeout(() => {
      void rotateLiveChunk({ final: false });
    }, LIVE_CHUNK_MS);
  }
  return { ok: true, paused: false };
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
    // Ensure recorders are not stuck paused before finalizing.
    if (isPaused) {
      await resumeRecording();
    }

    // Flush the last live ASR segment before stopping the main recorders.
    await stopLiveChunkCapture();

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
      case 'start-dictation':
        return startDictationRecording();
      case 'pause-recording':
        return pauseRecording();
      case 'resume-recording':
        return resumeRecording();
      case 'force-cleanup':
        await cleanup();
        return { ok: true };
      case 'stop-recording':
        return stopRecording();
      case 'get-visit-modality':
        return { ok: true, visitModality: resolveVisitModality() };
      case 'get-mic-level':
        return getMicLevel();
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

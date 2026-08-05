/**
 * Backend API client for meetings, transcripts, notes, and auth.
 * Loaded via importScripts in the service worker.
 */

const API_TIMEOUT_MS = 120_000;
const API_WAKE_TIMEOUT_MS = 90_000;
/** Long visits need more time for large uploads + Whisper + note generation. */
const AUDIO_UPLOAD_TIMEOUT_MS = 300_000;
const NOTE_GENERATE_TIMEOUT_MS = 600_000;
const NOTE_POLL_TIMEOUT_MS = 600_000;
/** Keep extension sign-in for at least one day (matches access JWT lifetime). */
const AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const AUTH_UI_CACHE_KEY = 'authUiCache';

class ApiClientError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'ApiClientError';
    this.status = options.status;
    this.code = options.code;
  }
}

function isAuthFailure(err) {
  return (
    err instanceof ApiClientError &&
    (err.status === 401 || err.code === 'AUTH_REQUIRED' || err.code === 'UNAUTHORIZED')
  );
}

async function getStoredAuthSession() {
  const stored = await chrome.storage.local.get(AUTH_STORAGE_KEY);
  return stored[AUTH_STORAGE_KEY] ?? null;
}

async function setStoredAuthSession(session) {
  if (!session) {
    await chrome.storage.local.remove([AUTH_STORAGE_KEY, AUTH_UI_CACHE_KEY]);
    return;
  }

  await chrome.storage.local.set({ [AUTH_STORAGE_KEY]: session });
}

async function cacheAuthUiSession(session) {
  if (!session?.user) {
    return;
  }

  await chrome.storage.local.set({
    [AUTH_UI_CACHE_KEY]: {
      user: session.user,
      usage: session.usage ?? null,
      cachedAt: Date.now(),
    },
  });

  const existing = await getStoredAuthSession();
  if (existing?.accessToken) {
    await setStoredAuthSession({
      ...existing,
      user: session.user,
      usage: session.usage ?? existing.usage ?? null,
    });
  }
}

async function getCachedAuthUiSession() {
  const auth = await getStoredAuthSession();
  if (!auth?.accessToken) {
    return null;
  }

  if (auth.expiresAt && Date.now() > auth.expiresAt) {
    return null;
  }

  const stored = await chrome.storage.local.get(AUTH_UI_CACHE_KEY);
  const cache = stored[AUTH_UI_CACHE_KEY];
  if (cache?.user) {
    return {
      user: cache.user,
      usage: cache.usage ?? auth.usage ?? null,
    };
  }

  if (auth.user) {
    return {
      user: auth.user,
      usage: auth.usage ?? null,
    };
  }

  return null;
}

async function getAccessToken() {
  const session = await getStoredAuthSession();
  if (!session?.accessToken) {
    return null;
  }

  if (session.expiresAt && Date.now() > session.expiresAt) {
    await setStoredAuthSession(null);
    return null;
  }

  return session.accessToken;
}

/**
 * @param {string} path
 * @param {RequestInit & { timeoutMs?: number, retries?: number, auth?: boolean }} [options]
 */
async function apiRequest(path, options = {}) {
  const { timeoutMs = API_TIMEOUT_MS, retries = 0, auth = true, ...fetchOptions } = options;
  const headers = { ...(fetchOptions.headers || {}) };

  if (auth) {
    const token = await getAccessToken();
    if (!token) {
      throw new ApiClientError('Please sign in to use md telescribe.', {
        status: 401,
        code: 'AUTH_REQUIRED',
      });
    }
    headers.Authorization = `Bearer ${token}`;
  }

  if (
    fetchOptions.body &&
    !(fetchOptions.body instanceof ArrayBuffer) &&
    !(fetchOptions.body instanceof Blob)
  ) {
    headers['Content-Type'] = 'application/json';
  }

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${API_BASE_URL}${path}`, {
        ...fetchOptions,
        headers,
        signal: controller.signal,
      });

      const json = await response.json().catch(() => null);
      if (!response.ok || !json || json.success === false) {
        throw new ApiClientError(json?.message || `API request failed (${response.status})`, {
          status: response.status,
          code: json?.code,
        });
      }

      if (json.data === undefined || json.data === null) {
        throw new ApiClientError('Server returned an empty response.', {
          status: response.status,
        });
      }

      return json.data;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const isNetwork =
        isAbort ||
        message.includes('Failed to fetch') ||
        message.includes('NetworkError') ||
        message.includes('network');

      if (attempt < retries && isNetwork) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
        continue;
      }

      if (err instanceof ApiClientError) {
        throw err;
      }

      if (isAbort) {
        throw new Error(
          'Could not reach the server. Check your internet connection and try again.'
        );
      }

      if (isNetwork) {
        throw new Error(
          'Could not reach the server. Check your internet connection and try again.'
        );
      }

      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

/** Ping the server so Render free tier is warm before stop/upload. */
async function wakeBackend() {
  return apiRequest('/health', {
    method: 'GET',
    timeoutMs: API_WAKE_TIMEOUT_MS,
    retries: 1,
    auth: false,
  });
}

/**
 * @param {{ email: string, password: string }} credentials
 */
async function login(credentials) {
  const data = await apiRequest('/auth/login', {
    method: 'POST',
    body: JSON.stringify(credentials),
    auth: false,
    timeoutMs: API_WAKE_TIMEOUT_MS,
    retries: 1,
  });

  // MFA pending responses have no access token — do not wipe/replace a good session.
  if (data?.requiresMfa || !data?.accessToken) {
    return data;
  }

  await setStoredAuthSession({
    accessToken: data.accessToken,
    user: data.user,
    usage: null,
    expiresAt: Date.now() + AUTH_SESSION_TTL_MS,
    signedInAt: Date.now(),
  });

  return data;
}

/**
 * Complete MFA login with the 6-digit authenticator code.
 * @param {{ mfaToken: string, code: string }} payload
 */
async function verifyMfaLogin(payload) {
  const data = await apiRequest('/auth/mfa/verify-login', {
    method: 'POST',
    body: JSON.stringify({
      mfaToken: payload.mfaToken,
      code: String(payload.code || '').trim(),
    }),
    auth: false,
    timeoutMs: API_WAKE_TIMEOUT_MS,
    retries: 1,
  });

  if (!data?.accessToken) {
    throw new ApiClientError('MFA verification failed. No access token returned.', {
      status: 401,
      code: 'AUTH_REQUIRED',
    });
  }

  await setStoredAuthSession({
    accessToken: data.accessToken,
    user: data.user,
    usage: null,
    expiresAt: Date.now() + AUTH_SESSION_TTL_MS,
    signedInAt: Date.now(),
  });

  return data;
}

async function logout() {
  await setStoredAuthSession(null);
}

async function getExtensionSession() {
  const session = await apiRequest('/auth/extension-session', {
    method: 'GET',
    timeoutMs: API_WAKE_TIMEOUT_MS,
    retries: 2,
  });
  await cacheAuthUiSession(session);
  return session;
}

function getSignupUrl() {
  return `${APP_BASE_URL}/signup`;
}

function getPricingUrl() {
  return `${APP_BASE_URL}/pricing`;
}

function getLoginUrl() {
  return `${APP_BASE_URL}/login`;
}

/**
 * @param {string} [title]
 * @param {'AUDIO' | 'VIDEO' | 'IN_PERSON'} [visitModality]
 */
async function createMeeting(title, visitModality = 'AUDIO') {
  return apiRequest('/meetings', {
    method: 'POST',
    body: JSON.stringify({
      title: title || 'Visit Recording',
      visitModality,
    }),
  });
}

/**
 * @param {string} meetingId
 * @param {Array<{ text: string, speaker?: string, startMs?: number, endMs?: number, isFinal?: boolean }>} segments
 */
async function saveTranscriptSegments(meetingId, segments) {
  if (!segments.length) {
    return [];
  }

  return apiRequest(`/meetings/${meetingId}/transcripts/bulk`, {
    method: 'POST',
    body: JSON.stringify({ segments }),
  });
}

/**
 * @param {string} meetingId
 * @param {ArrayBuffer} audioBuffer
 */
async function uploadMeetingAudio(meetingId, audioBuffer, source = 'mixed') {
  return apiRequest(`/meetings/${meetingId}/audio`, {
    method: 'POST',
    headers: {
      'Content-Type': 'audio/webm',
      'X-Audio-Source': source,
    },
    body: audioBuffer,
    timeoutMs: AUDIO_UPLOAD_TIMEOUT_MS,
  });
}

/**
 * Transcribe a short in-visit audio chunk (Whisper) and append to the meeting transcript.
 * @param {string} meetingId
 * @param {ArrayBuffer} audioBuffer
 */
async function transcribeMeetingChunk(meetingId, audioBuffer) {
  return apiRequest(`/meetings/${meetingId}/transcribe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'audio/webm',
    },
    body: audioBuffer,
    timeoutMs: 90_000,
    retries: 1,
  });
}

/**
 * @param {string} meetingId
 */
async function completeMeeting(meetingId) {
  return apiRequest(`/meetings/${meetingId}/complete`, { method: 'POST' });
}

async function getMeeting(meetingId) {
  return apiRequest(`/meetings/${meetingId}`);
}

function isTransientNetworkError(err) {
  if (!(err instanceof Error)) {
    return false;
  }

  const message = err.message;
  const status = err instanceof ApiClientError ? err.status : undefined;
  return (
    err.name === 'AbortError' ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    message.includes('Could not reach the server') ||
    message.includes('Failed to fetch') ||
    message.includes('NetworkError') ||
    message.includes('API request failed (500)') ||
    message.includes('API request failed (502)') ||
    message.includes('API request failed (503)') ||
    message.includes('API request failed (504)')
  );
}

/**
 * @param {object | null | undefined} meeting
 * @param {{ content?: string }} note
 * @returns {{ note: typeof note, visitModality: 'AUDIO' | 'VIDEO' | 'IN_PERSON' }}
 */
function wrapMeetingNoteResult(meeting, note) {
  const modality = meeting?.visitModality;
  return {
    note,
    visitModality:
      modality === 'VIDEO' || modality === 'IN_PERSON' || modality === 'AUDIO'
        ? modality
        : 'AUDIO',
  };
}

/**
 * Poll GET /meetings/:id until a note with content exists.
 * @param {string} meetingId
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 * @returns {Promise<{ note: object, visitModality: 'AUDIO' | 'VIDEO' | 'IN_PERSON' }>}
 */
async function pollMeetingNote(meetingId, options = {}) {
  const timeoutMs = options.timeoutMs ?? NOTE_POLL_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? 2500;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const meeting = await getMeeting(meetingId);
    if (meeting?.note?.content?.trim()) {
      return wrapMeetingNoteResult(meeting, meeting.note);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    'Note generation timed out. Your recording was saved — keep this popup open and try again.'
  );
}

/**
 * Start note generation on the server, then poll until the note is ready.
 * Polling survives dropped long-running connections (common in MV3 service workers).
 * @param {string} meetingId
 * @param {'AUDIO' | 'VIDEO' | 'IN_PERSON'} [visitModality]
 * @returns {Promise<{ note: object, visitModality: 'AUDIO' | 'VIDEO' | 'IN_PERSON' }>}
 */
async function generateMeetingNotes(meetingId, visitModality) {
  const deadline = Date.now() + NOTE_GENERATE_TIMEOUT_MS;
  let generateError = null;
  let generateSettled = false;
  let generateAttempts = 0;
  let lastKickAt = 0;
  const generateBody = visitModality ? { visitModality } : {};

  // Server returns quickly and runs Whisper/GPT in the background.
  // Keep this kick timeout short so proxies don't kill a long-held connection.
  const kickGenerate = () => {
    generateAttempts += 1;
    lastKickAt = Date.now();
    generateSettled = false;
    generateError = null;
    void apiRequest(`/meetings/${meetingId}/notes/generate`, {
      method: 'POST',
      body: JSON.stringify(generateBody),
      timeoutMs: 60_000,
      retries: 2,
    })
      .catch((err) => {
        generateError = err;
      })
      .finally(() => {
        generateSettled = true;
      });
  };

  kickGenerate();

  while (Date.now() < deadline) {
    try {
      const meeting = await getMeeting(meetingId);
      if (meeting?.note?.content?.trim()) {
        return wrapMeetingNoteResult(meeting, meeting.note);
      }
    } catch (err) {
      if (!isTransientNetworkError(err)) {
        throw err;
      }
      generateError = err;
    }

    // Retry kick on DB blips / 5xx, and periodically re-kick while still waiting.
    const shouldRetryTransient =
      generateSettled &&
      generateError &&
      isTransientNetworkError(generateError) &&
      generateAttempts < 8;
    const shouldRekickIdle =
      generateSettled && !generateError && Date.now() - lastKickAt > 12_000 && generateAttempts < 8;

    if (shouldRetryTransient || shouldRekickIdle) {
      await new Promise((resolve) => setTimeout(resolve, shouldRetryTransient ? 2000 : 500));
      kickGenerate();
      continue;
    }

    if (generateSettled && generateError && !isTransientNetworkError(generateError)) {
      throw generateError;
    }

    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  if (generateError && !isTransientNetworkError(generateError)) {
    throw generateError;
  }

  throw new Error(
    'Note generation timed out. Your recording was saved — keep this popup open and try again.'
  );
}

/**
 * @param {string} meetingId
 * @param {{ title?: string, summary?: string, content: string }} note
 */
async function saveMeetingNote(meetingId, note) {
  return apiRequest(`/meetings/${meetingId}/notes`, {
    method: 'POST',
    body: JSON.stringify(note),
  });
}

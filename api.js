/**
 * Backend API client for meetings, transcripts, notes, and auth.
 * Loaded via importScripts in the service worker.
 */

const API_TIMEOUT_MS = 120_000;
const API_WAKE_TIMEOUT_MS = 90_000;

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

async function getStoredAuthSession() {
  const stored = await chrome.storage.local.get(AUTH_STORAGE_KEY);
  return stored[AUTH_STORAGE_KEY] ?? null;
}

async function setStoredAuthSession(session) {
  if (!session) {
    await chrome.storage.local.remove(AUTH_STORAGE_KEY);
    return;
  }

  await chrome.storage.local.set({ [AUTH_STORAGE_KEY]: session });
}

async function getAccessToken() {
  const session = await getStoredAuthSession();
  return session?.accessToken ?? null;
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
  });

  await setStoredAuthSession({
    accessToken: data.accessToken,
    user: data.user,
  });

  return data;
}

async function logout() {
  await setStoredAuthSession(null);
}

async function getExtensionSession() {
  return apiRequest('/auth/extension-session', { method: 'GET' });
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
 * @param {'AUDIO' | 'VIDEO'} [visitModality]
 */
async function createMeeting(title, visitModality = 'AUDIO') {
  return apiRequest('/meetings', {
    method: 'POST',
    body: JSON.stringify({
      title: title || 'Tab + Mic Recording',
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
    timeoutMs: 180_000,
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
  return (
    err.name === 'AbortError' ||
    message.includes('Could not reach the server') ||
    message.includes('Failed to fetch') ||
    message.includes('NetworkError')
  );
}

/**
 * @param {object | null | undefined} meeting
 * @param {{ content?: string }} note
 * @returns {{ note: typeof note, visitModality: 'AUDIO' | 'VIDEO' }}
 */
function wrapMeetingNoteResult(meeting, note) {
  return {
    note,
    visitModality: meeting?.visitModality === 'VIDEO' ? 'VIDEO' : 'AUDIO',
  };
}

/**
 * Poll GET /meetings/:id until a note with content exists.
 * @param {string} meetingId
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 * @returns {Promise<{ note: object, visitModality: 'AUDIO' | 'VIDEO' }>}
 */
async function pollMeetingNote(meetingId, options = {}) {
  const timeoutMs = options.timeoutMs ?? 180_000;
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
 * @param {'AUDIO' | 'VIDEO'} [visitModality]
 * @returns {Promise<{ note: object, visitModality: 'AUDIO' | 'VIDEO' }>}
 */
async function generateMeetingNotes(meetingId, visitModality) {
  const deadline = Date.now() + 180_000;
  let generateResult = null;
  let generateError = null;
  let generateSettled = false;
  const generateBody = visitModality ? { visitModality } : {};

  void apiRequest(`/meetings/${meetingId}/notes/generate`, {
    method: 'POST',
    body: JSON.stringify(generateBody),
    timeoutMs: 180_000,
  })
    .then((note) => {
      generateResult = note;
    })
    .catch((err) => {
      generateError = err;
    })
    .finally(() => {
      generateSettled = true;
    });

  while (Date.now() < deadline) {
    if (generateResult?.content?.trim()) {
      try {
        const meeting = await getMeeting(meetingId);
        return wrapMeetingNoteResult(meeting, generateResult);
      } catch {
        return wrapMeetingNoteResult(null, generateResult);
      }
    }

    if (generateSettled && generateError && !isTransientNetworkError(generateError)) {
      throw generateError;
    }

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

    await new Promise((resolve) => setTimeout(resolve, 2500));
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

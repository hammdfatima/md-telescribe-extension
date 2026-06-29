/**
 * Visit modality detection helpers (loaded in the service worker).
 */

/** Minimum visible video size to count as a camera visit. */
const MIN_VIDEO_PX = 120;

/**
 * Runs inside the telemedicine tab. Returns VIDEO when an active video feed is visible.
 * @returns {'AUDIO' | 'VIDEO'}
 */
function detectVisitModalityInPage() {
  const videos = Array.from(document.querySelectorAll('video'));

  const hasActiveVideo = videos.some((video) => {
    const rect = video.getBoundingClientRect();
    if (rect.width < MIN_VIDEO_PX || rect.height < MIN_VIDEO_PX) {
      return false;
    }
    if (video.readyState < 2 || video.paused) {
      return false;
    }
    return video.videoWidth >= MIN_VIDEO_PX && video.videoHeight >= MIN_VIDEO_PX;
  });

  return hasActiveVideo ? 'VIDEO' : 'AUDIO';
}

/**
 * @param {number | undefined} tabId
 * @returns {Promise<'AUDIO' | 'VIDEO' | null>}
 */
async function detectVisitModalityFromTab(tabId) {
  if (!tabId) {
    return null;
  }

  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: detectVisitModalityInPage,
    });
    return injection?.result === 'VIDEO' ? 'VIDEO' : 'AUDIO';
  } catch (err) {
    console.warn('[visit-modality] page detection failed:', err);
    return null;
  }
}

/**
 * Prefer VIDEO when any signal indicates a camera visit.
 * @param {Array<'AUDIO' | 'VIDEO' | null | undefined>} signals
 * @returns {'AUDIO' | 'VIDEO'}
 */
function mergeVisitModality(...signals) {
  for (const signal of signals) {
    if (signal === 'VIDEO') {
      return 'VIDEO';
    }
  }
  return 'AUDIO';
}

/**
 * Use the modality shown during recording; avoid upgrading at stop from page video
 * (e.g. YouTube) that is not the telemedicine visit.
 * @param {{
 *   detectedVisitModality?: 'AUDIO' | 'VIDEO' | null,
 *   pageVisitModality?: 'AUDIO' | 'VIDEO' | null,
 *   stopSignal?: 'AUDIO' | 'VIDEO' | null,
 * }} options
 * @returns {'AUDIO' | 'VIDEO'}
 */
function resolveRecordingVisitModality(options = {}) {
  const { detectedVisitModality, pageVisitModality, stopSignal } = options;

  if (detectedVisitModality === 'VIDEO' || detectedVisitModality === 'AUDIO') {
    return detectedVisitModality;
  }

  return mergeVisitModality(stopSignal, pageVisitModality);
}

function visitModalityLabel(modality) {
  return modality === 'VIDEO' ? 'video visit' : 'audio visit';
}

/**
 * In-page meeting detector + prompt for opening md telescribe.
 * Injected on known telemedicine / video-call hosts.
 */

(() => {
  if (window.__mdtsMeetingPromptLoaded) {
    return;
  }
  window.__mdtsMeetingPromptLoaded = true;

  const ROOT_ID = 'mdts-meeting-prompt-root';
  const PANEL_ROOT_ID = 'mdts-extension-panel-root';
  const DISMISS_PREFIX = 'mdts-meeting-prompt-dismissed:';
  const CHECK_INTERVAL_MS = 2500;

  /** @type {'idle' | 'ask' | 'opening' | 'hidden'} */
  let viewState = 'idle';
  /** @type {HTMLElement | null} */
  let rootEl = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let pollId = null;
  let lastMeetingKey = '';

  function sendToBackground(type, data = {}) {
    return chrome.runtime.sendMessage({ target: 'background', type, data });
  }

  function meetingKey() {
    return `${location.hostname}${location.pathname}`;
  }

  function isDismissed() {
    try {
      return sessionStorage.getItem(DISMISS_PREFIX + meetingKey()) === '1';
    } catch {
      return false;
    }
  }

  function setDismissed() {
    try {
      sessionStorage.setItem(DISMISS_PREFIX + meetingKey(), '1');
    } catch {
      // Ignore storage failures (private mode quirks).
    }
  }

  function hostLooksLikeMeetingSite() {
    const host = location.hostname.toLowerCase();
    return (
      host === 'meet.google.com' ||
      host.endsWith('.zoom.us') ||
      host === 'zoom.us' ||
      host.endsWith('.zoom.com') ||
      host === 'teams.microsoft.com' ||
      host === 'teams.live.com' ||
      host.endsWith('.webex.com') ||
      host.endsWith('.doxy.me') ||
      host === 'doxy.me' ||
      host.includes('teladoc') ||
      host.includes('amwell') ||
      host.includes('doctorsondemand') ||
      host.includes('mdlive') ||
      host.includes('vsee') ||
      host.includes('doxy')
    );
  }

  function hasLeaveOrEndControl() {
    const selectors = [
      '[aria-label*="Leave call" i]',
      '[aria-label*="Leave meeting" i]',
      '[aria-label*="End call" i]',
      '[aria-label*="End meeting" i]',
      '[aria-label*="Hang up" i]',
      '[data-tooltip*="Leave call" i]',
      'button[aria-label*="Leave" i]',
      '#leave-call-button',
      '[data-tid="call-hangup"]',
      '[data-tid="hangup-button"]',
    ];

    for (const selector of selectors) {
      try {
        if (document.querySelector(selector)) {
          return true;
        }
      } catch {
        // Some browsers reject case-insensitive attribute selectors.
      }
    }

    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    return buttons.some((el) => {
      const label = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`.toLowerCase();
      return (
        label.includes('leave call') ||
        label.includes('leave meeting') ||
        label.includes('end call') ||
        label.includes('end meeting') ||
        label.includes('hang up')
      );
    });
  }

  function urlLooksInMeeting() {
    const host = location.hostname.toLowerCase();
    const path = location.pathname.toLowerCase();
    const hash = location.hash.toLowerCase();

    if (host === 'meet.google.com') {
      return /\/[a-z0-9]{2,4}-[a-z0-9]{3,5}-[a-z0-9]{2,4}/i.test(path);
    }

    if (host.includes('zoom')) {
      return (
        path.includes('/wc/') ||
        path.includes('/j/') ||
        path.includes('/s/') ||
        path.includes('/meeting')
      );
    }

    if (host.includes('teams')) {
      return (
        path.includes('/call') ||
        path.includes('/meetup-join') ||
        path.includes('/l/meetup') ||
        hash.includes('/calling/') ||
        hash.includes('meetup-join')
      );
    }

    if (host.includes('webex')) {
      return path.includes('/meet') || path.includes('/join');
    }

    return path.length > 1;
  }

  function hasActiveMeetingMedia() {
    const videos = Array.from(document.querySelectorAll('video'));
    const liveVideo = videos.some((video) => {
      const rect = video.getBoundingClientRect();
      const visible = rect.width >= 80 && rect.height >= 80;
      return visible && video.readyState >= 2 && video.videoWidth >= 80;
    });
    if (liveVideo) {
      return true;
    }

    return Boolean(
      document.querySelector('audio[srcObject], video[srcObject]') ||
        document.querySelector('[class*="participant" i], [class*="meeting" i]')
    );
  }

  function isLikelyInMeeting() {
    if (!hostLooksLikeMeetingSite()) {
      return false;
    }
    if (!urlLooksInMeeting()) {
      return false;
    }
    return hasLeaveOrEndControl() || hasActiveMeetingMedia();
  }

  function ensureRoot() {
    if (rootEl && document.documentElement.contains(rootEl)) {
      return rootEl;
    }

    rootEl = document.createElement('div');
    rootEl.id = ROOT_ID;
    rootEl.innerHTML = `
      <div class="mdts-card" role="dialog" aria-live="polite" aria-label="md telescribe meeting prompt">
        <div class="mdts-brand">
          <img alt="" width="40" height="40" />
          <span>md <em>telescribe</em></span>
          <button type="button" class="mdts-close" data-action="close" aria-label="Close" title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
              <path d="M18 6 6 18"></path>
              <path d="m6 6 12 12"></path>
            </svg>
          </button>
        </div>
        <div data-view="ask">
          <p class="mdts-title">You're in a meeting</p>
          <p class="mdts-body">Open md telescribe to choose Video or Audio visit and start recording.</p>
          <p class="mdts-error mdts-hidden" data-error></p>
          <div class="mdts-actions">
            <button type="button" class="mdts-btn mdts-btn-primary" data-action="yes">Yes, open extension</button>
            <button type="button" class="mdts-btn mdts-btn-ghost" data-action="no">Not now</button>
          </div>
        </div>
        <div class="mdts-hidden" data-view="opening">
          <p class="mdts-title">Opening md telescribe…</p>
          <p class="mdts-body">Choose Video visit or Audio visit in the extension to start recording.</p>
        </div>
      </div>
    `;

    const logo = rootEl.querySelector('img');
    if (logo) {
      logo.src = chrome.runtime.getURL('icons/logo.png');
    }

    rootEl.addEventListener('click', onRootClick);
    document.documentElement.appendChild(rootEl);
    return rootEl;
  }

  function setError(text) {
    const card = rootEl;
    if (!card) return;
    card.querySelectorAll('[data-error]').forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      if (text) {
        el.textContent = text;
        el.classList.remove('mdts-hidden');
      } else {
        el.textContent = '';
        el.classList.add('mdts-hidden');
      }
    });
  }

  function showView(next) {
    viewState = next;
    const card = ensureRoot();
    card.querySelectorAll('[data-view]').forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      const match = el.getAttribute('data-view') === next;
      el.classList.toggle('mdts-hidden', !match);
    });
    setError('');
    card.style.display = next === 'hidden' ? 'none' : '';
  }

  function hidePrompt() {
    viewState = 'hidden';
    if (rootEl) {
      rootEl.style.display = 'none';
      rootEl.remove();
      rootEl = null;
    }
  }

  function dismissPromptPermanently() {
    setDismissed();
    hidePrompt();
  }

  function showAskPrompt() {
    ensureRoot();
    if (rootEl) {
      rootEl.style.display = '';
    }
    showView('ask');
  }

  async function onRootClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('[data-action]');
    if (!(button instanceof HTMLElement)) return;

    const action = button.getAttribute('data-action');
    if (action === 'no' || action === 'close') {
      dismissPromptPermanently();
      return;
    }

    if (action === 'yes') {
      await openExtension(button);
    }
  }

  async function openExtension(button) {
    setError('');
    showView('opening');
    if (button instanceof HTMLButtonElement) {
      button.disabled = true;
    }

    try {
      const response = await sendToBackground('open-extension-from-meeting', {});

      if (!response?.ok) {
        const message = response?.error || 'Could not open md telescribe.';
        showView('ask');
        setError(message);
        return;
      }

      // Toolbar popup when Chrome allows it; otherwise in-page extension modal.
      if (response.opened !== 'popup') {
        showExtensionPanelModal();
      }

      dismissPromptPermanently();
    } catch (err) {
      showView('ask');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (button instanceof HTMLButtonElement) {
        button.disabled = false;
      }
    }
  }

  function closeExtensionPanelModal() {
    const existing = document.getElementById(PANEL_ROOT_ID);
    if (existing) {
      existing.remove();
    }
  }

  function showExtensionPanelModal() {
    closeExtensionPanelModal();

    const panel = document.createElement('div');
    panel.id = PANEL_ROOT_ID;
    panel.innerHTML = `
      <div class="mdts-panel-backdrop" data-action="close-panel" aria-hidden="true"></div>
      <div class="mdts-panel" role="dialog" aria-modal="true" aria-label="md telescribe">
        <button type="button" class="mdts-panel-close" data-action="close-panel" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
            <path d="M18 6 6 18"></path>
            <path d="m6 6 12 12"></path>
          </svg>
        </button>
        <iframe
          title="md telescribe"
          src="${chrome.runtime.getURL('popup.html')}"
          allow="microphone"
        ></iframe>
      </div>
    `;

    panel.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('[data-action="close-panel"]')) {
        closeExtensionPanelModal();
      }
    });

    document.documentElement.appendChild(panel);
  }

  async function maybeShowPrompt() {
    if (viewState === 'opening') {
      return;
    }

    try {
      const state = await sendToBackground('get-recording-state');
      if (state?.recording || state?.busy) {
        dismissPromptPermanently();
        return;
      }
    } catch {
      return;
    }

    if (viewState === 'ask') {
      // Keep asking view visible unless meeting ended / dismissed.
    }

    const key = meetingKey();
    if (key !== lastMeetingKey) {
      lastMeetingKey = key;
      if (viewState === 'ask') {
        hidePrompt();
      }
    }

    if (!isLikelyInMeeting() || isDismissed()) {
      if (viewState === 'ask') {
        hidePrompt();
      }
      return;
    }

    if (viewState !== 'ask') {
      showAskPrompt();
    }
  }

  function startPolling() {
    if (pollId !== null) return;
    void maybeShowPrompt();
    pollId = setInterval(() => {
      void maybeShowPrompt();
    }, CHECK_INTERVAL_MS);
  }

  const observer = new MutationObserver(() => {
    if (viewState === 'idle' || viewState === 'hidden') {
      void maybeShowPrompt();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  window.addEventListener('popstate', () => {
    void maybeShowPrompt();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.target !== 'meeting-prompt') return;
    if (message.type === 'dismiss') {
      dismissPromptPermanently();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.recording?.newValue === true) {
      dismissPromptPermanently();
    }
  });

  startPolling();
})();

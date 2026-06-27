(() => {
  if (globalThis.spotifyAdRefreshMonitorLoaded) {
    return;
  }

  globalThis.spotifyAdRefreshMonitorLoaded = true;

  const ACTIVE_KEY = "monitoringActive";
  const STATUS_KEY = "statusText";
  const RESUME_KEY = "resumeAfterReload";
  const LAST_REFRESH_KEY = "lastRefreshAt";
  const REFRESH_COOLDOWN_MS = 15000;
  const REQUIRED_AD_DETECTIONS = 2;

  let isRunning = false;
  let isRefreshing = false;
  let adDetectionCount = 0;
  let lastAdReason = null;
  let observer = null;
  let pollId = null;

  initializeContentScript();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "PING") {
      sendResponse({ ok: true, running: isRunning });
      return false;
    }

    if (message.type === "START_MONITORING") {
      startMonitoring();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "STOP_MONITORING") {
      stopMonitoring();
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  async function initializeContentScript() {
    const data = await chrome.storage.local.get([ACTIVE_KEY, RESUME_KEY]);

    if (!data[ACTIVE_KEY]) {
      return;
    }

    if (data[RESUME_KEY]) {
      const shouldStartMonitoring = await resumeAfterReload();

      if (!shouldStartMonitoring) {
        return;
      }
    }

    startMonitoring();
  }

  function startMonitoring() {
    if (isRunning) {
      return;
    }

    isRunning = true;
    setStatus("Monitoring");

    // MutationObserver catches Spotify UI changes as soon as the player DOM updates.
    observer = new MutationObserver(handleSpotifyUpdate);
    observer.observe(document.body || document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "data-testid", "title"]
    });

    // A short DOM poll is only a fallback; it is not based on song/ad length.
    pollId = window.setInterval(handleSpotifyUpdate, 1500);
    handleSpotifyUpdate();
  }

  function stopMonitoring() {
    isRunning = false;
    isRefreshing = false;
    observer?.disconnect();
    observer = null;
    window.clearInterval(pollId);
    pollId = null;
    chrome.storage.local.set({ [RESUME_KEY]: false, [STATUS_KEY]: "Stopped" });
  }

  function handleSpotifyUpdate() {
    if (!isRunning || isRefreshing) {
      return;
    }

    const indicator = findAdIndicator();

    if (indicator) {
      confirmAdThenRefresh(indicator.reason);
      return;
    }

    adDetectionCount = 0;
    lastAdReason = null;
  }

  function findAdIndicator() {
    const roots = getPlayerRoots();

    for (const root of roots) {
      const structuralAdNode = safeQuerySelector(
        root,
        '[data-testid^="ad-"], [data-testid*="advertisement" i], [data-testid*="sponsored" i]'
      );

      if (structuralAdNode) {
        return { reason: "ad-like data-testid in the player" };
      }

      const labelledAdNode = safeQuerySelector(
        root,
        '[aria-label*="Advertisement" i], [title*="Advertisement" i], [aria-label*="Sponsored" i], [title*="Sponsored" i]'
      );

      if (labelledAdNode) {
        return { reason: "Advertisement/Sponsored label in the player" };
      }

      if (containsAdText(root.innerText || root.textContent)) {
        return { reason: "Advertisement/Sponsored text in the player" };
      }
    }

    if (containsAdText(document.title)) {
      return { reason: "Advertisement/Sponsored text in the document title" };
    }

    return null;
  }

  function getPlayerRoots() {
    const selectors = [
      '[data-testid="now-playing-widget"]',
      '[data-testid="player-bar"]'
    ];

    const roots = [];

    for (const selector of selectors) {
      const root = safeQuerySelector(document, selector);

      if (root && !roots.includes(root)) {
        roots.push(root);
      }
    }

    return roots;
  }

  function safeQuerySelector(parent, selector) {
    try {
      return parent.querySelector(selector);
    } catch (error) {
      console.warn(`Skipped invalid selector: ${selector}`, error);
      return null;
    }
  }

  function containsAdText(value = "") {
    const text = value.replace(/\s+/g, " ").trim();
    return /\b(advertisement|sponsored)\b/i.test(text);
  }

  function confirmAdThenRefresh(reason) {
    if (reason === lastAdReason) {
      adDetectionCount += 1;
    } else {
      lastAdReason = reason;
      adDetectionCount = 1;
    }

    if (adDetectionCount >= REQUIRED_AD_DETECTIONS) {
      refreshSpotifyPage(reason);
    } else {
      setStatus("Possible ad detected. Confirming...");
    }
  }

  async function refreshSpotifyPage(reason) {
    isRefreshing = true;

    const data = await chrome.storage.local.get(LAST_REFRESH_KEY);
    const lastRefreshAt = Number(data[LAST_REFRESH_KEY] || 0);
    const now = Date.now();

    if (now - lastRefreshAt < REFRESH_COOLDOWN_MS) {
      isRefreshing = false;
      return;
    }

    await chrome.storage.local.set({
      [RESUME_KEY]: true,
      [LAST_REFRESH_KEY]: now,
      [STATUS_KEY]: `Ad detected (${reason}). Refreshing...`
    });

    window.location.reload();
  }

  async function resumeAfterReload() {
    await waitForFullPageLoad();

    await chrome.storage.local.set({
      [RESUME_KEY]: false,
      [STATUS_KEY]: "Spotify loaded. Pressing playlist Play..."
    });

    await delay(2500);
    await clickPlaylistPlayButton();

    return true;
  }

  async function clickPlaylistPlayButton() {
    const button = await waitForElement(findReadyPlaylistPlayButton, 30000);

    if (!button) {
      setStatus('Monitoring. Could not find the playlist "play-button".');
      return;
    }

    if (isPauseButton(button)) {
      setStatus("Monitoring. Playback is already running.");
      return;
    }

    if (isButtonDisabled(button)) {
      setStatus("Monitoring. Play button is not ready yet.");
      return;
    }

    button.click();
    await delay(800);

    if (isPauseButton(findPlaylistPlayButton())) {
      setStatus("Monitoring. Playlist playback resumed.");
    } else {
      setStatus('Monitoring. Clicked playlist "play-button"; a real user click may be required.');
    }
  }

  function findPlaylistPlayButton() {
    return (
      document.querySelector('[data-testid="action-bar-row"] button[data-testid="play-button"]') ||
      document.querySelector('main button[data-testid="play-button"]') ||
      document.querySelector('button[data-testid="play-button"]')
    );
  }

  function findReadyPlaylistPlayButton() {
    const button = findPlaylistPlayButton();

    if (!button) {
      return null;
    }

    return isPauseButton(button) || !isButtonDisabled(button) ? button : null;
  }

  function isPauseButton(button) {
    return Boolean(button?.getAttribute("aria-label")?.toLowerCase().includes("pause"));
  }

  function isButtonDisabled(button) {
    return button.disabled || button.getAttribute("aria-disabled") === "true";
  }

  function waitForFullPageLoad() {
    if (document.readyState === "complete") {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      window.addEventListener("load", resolve, { once: true });
    });
  }

  function waitForElement(getElement, timeoutMs) {
    const startedAt = Date.now();

    return new Promise((resolve) => {
      const intervalId = window.setInterval(() => {
        const element = getElement();

        if (element || Date.now() - startedAt > timeoutMs) {
          window.clearInterval(intervalId);
          resolve(element || null);
        }
      }, 250);
    });
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function setStatus(text) {
    chrome.storage.local.set({ [STATUS_KEY]: text });
  }
})();

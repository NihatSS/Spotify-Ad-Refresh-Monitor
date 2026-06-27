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
  let extensionContextInvalidated = false;

  registerMessageListener();
  initializeContentScript().catch(handleExtensionError);

  function registerMessageListener() {
    if (!hasExtensionContext()) {
      return;
    }

    try {
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
    } catch (error) {
      handleExtensionError(error);
    }
  }

  async function initializeContentScript() {
    const data = await storageGet([ACTIVE_KEY, RESUME_KEY]);

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
    stopLocalMonitoring();
    storageSet({ [RESUME_KEY]: false, [STATUS_KEY]: "Stopped" });
  }

  function stopLocalMonitoring() {
    isRunning = false;
    isRefreshing = false;
    observer?.disconnect();
    observer = null;
    window.clearInterval(pollId);
    pollId = null;
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
      refreshSpotifyPage(reason).catch(handleExtensionError);
    } else {
      setStatus("Possible ad detected. Confirming...");
    }
  }

  async function refreshSpotifyPage(reason) {
    isRefreshing = true;

    if (!hasExtensionContext()) {
      stopLocalMonitoring();
      return;
    }

    const data = await storageGet(LAST_REFRESH_KEY);
    const lastRefreshAt = Number(data[LAST_REFRESH_KEY] || 0);
    const now = Date.now();

    if (now - lastRefreshAt < REFRESH_COOLDOWN_MS) {
      isRefreshing = false;
      return;
    }

    const didSaveRefreshState = await storageSet({
      [RESUME_KEY]: true,
      [LAST_REFRESH_KEY]: now,
      [STATUS_KEY]: `Ad detected (${reason}). Refreshing...`
    });

    if (didSaveRefreshState) {
      window.location.reload();
    }
  }

  async function resumeAfterReload() {
    await waitForFullPageLoad();

    await storageSet({
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
    storageSet({ [STATUS_KEY]: text });
  }

  async function storageGet(keys) {
    if (!hasExtensionContext()) {
      stopLocalMonitoring();
      return {};
    }

    try {
      return await chrome.storage.local.get(keys);
    } catch (error) {
      handleExtensionError(error);
      return {};
    }
  }

  async function storageSet(values) {
    if (!hasExtensionContext()) {
      stopLocalMonitoring();
      return false;
    }

    try {
      await chrome.storage.local.set(values);
      return true;
    } catch (error) {
      handleExtensionError(error);
      return false;
    }
  }

  function hasExtensionContext() {
    if (extensionContextInvalidated || typeof chrome === "undefined") {
      return false;
    }

    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      extensionContextInvalidated = true;
      return false;
    }
  }

  function handleExtensionError(error) {
    if (isExtensionContextInvalidatedError(error) || !hasExtensionContext()) {
      extensionContextInvalidated = true;
      stopLocalMonitoring();
      return;
    }

    console.error("Spotify Ad Monitor error:", error);
  }

  function isExtensionContextInvalidatedError(error) {
    const message = String(error?.message || error || "");
    return message.toLowerCase().includes("extension context invalidated");
  }
})();

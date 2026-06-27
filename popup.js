const ACTIVE_KEY = "monitoringActive";
const STATUS_KEY = "statusText";
const TAB_KEY = "spotifyTabId";
const SPOTIFY_URL = "https://open.spotify.com/*";

const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const statusText = document.querySelector("#statusText");

document.addEventListener("DOMContentLoaded", initializePopup);

async function initializePopup() {
  startButton.addEventListener("click", startMonitoring);
  stopButton.addEventListener("click", stopMonitoring);
  chrome.storage.onChanged.addListener(renderStatus);
  await renderStatus();
}

async function startMonitoring() {
  setButtonsBusy(true);
  setStatus("Looking for an open Spotify tab...");

  try {
    const tab = await findSpotifyTab();

    if (!tab) {
      await chrome.storage.local.set({
        [ACTIVE_KEY]: false,
        [STATUS_KEY]: "Open Spotify Web Player first."
      });
      return;
    }

    await chrome.storage.local.set({
      [ACTIVE_KEY]: true,
      [TAB_KEY]: tab.id,
      [STATUS_KEY]: "Starting monitor..."
    });

    await ensureContentScript(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "START_MONITORING" });
    await chrome.storage.local.set({ [STATUS_KEY]: "Monitoring" });
  } catch (error) {
    await chrome.storage.local.set({
      [ACTIVE_KEY]: false,
      [STATUS_KEY]: `Could not start: ${error.message}`
    });
  } finally {
    setButtonsBusy(false);
    await renderStatus();
  }
}

async function stopMonitoring() {
  setButtonsBusy(true);

  try {
    const stored = await chrome.storage.local.get(TAB_KEY);
    const tab = stored[TAB_KEY] ? { id: stored[TAB_KEY] } : await findSpotifyTab();

    await chrome.storage.local.set({
      [ACTIVE_KEY]: false,
      [STATUS_KEY]: "Stopped"
    });

    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, { type: "STOP_MONITORING" }).catch(() => {});
    }
  } finally {
    setButtonsBusy(false);
    await renderStatus();
  }
}

async function findSpotifyTab() {
  const tabs = await chrome.tabs.query({ url: SPOTIFY_URL });
  return tabs.find((tab) => tab.active) || tabs[0];
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  }
}

async function renderStatus() {
  const data = await chrome.storage.local.get([ACTIVE_KEY, STATUS_KEY]);
  const isActive = Boolean(data[ACTIVE_KEY]);

  statusText.textContent = data[STATUS_KEY] || (isActive ? "Monitoring" : "Stopped");
  startButton.disabled = isActive;
  stopButton.disabled = !isActive;
}

function setButtonsBusy(isBusy) {
  startButton.disabled = isBusy;
  stopButton.disabled = isBusy;
}

function setStatus(text) {
  statusText.textContent = text;
}

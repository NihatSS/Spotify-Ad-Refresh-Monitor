## How to Run

1. Open Chrome and go to `chrome://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked.
4. Select this project folder.
5. Open the Spotify playlist you are currently listening to.
6. Click the extension icon, then click Start.

## Troubleshooting

If you see `Extension context invalidated`, reload the extension in `chrome://extensions`, then refresh the Spotify tab. That error happens when Chrome keeps an older content script alive after the extension has been reloaded or removed. The current script handles this more safely, but the old script must be cleared by refreshing the Spotify page.

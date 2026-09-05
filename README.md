# NoBreaks

A small Chrome extension that skips Twitch ad breaks. When the live stream you're watching switches to server-side ads, NoBreaks swaps in an ad-free copy of the same stream and switches back when the break is over. Everything happens in the browser; the only requests it adds are the ones Twitch's own player would make for another player type.

## How it works

Twitch inserts ads into the live stream itself. While an ad plays, the media playlist the player polls lists ad segments marked with `stitched-ad` tags. The player fetches its playlists from a web worker, so the extension wraps that worker, hooks `fetch` inside it and, whenever a playlist carries ads, requests the same stream as another player type (`embed`, then `thunderdome`, which is limited to 480p) and hands the player that playlist instead. A small "Skipping ad break..." notice is shown meanwhile and the skipped time is counted in the popup.

On some channels Twitch serves the ad markers to those player types as well and shows "Commercial break in progress". There is no ad-free variant in that case and the stream is left alone.

## Install

Either download the release zip or clone the repository, then load the folder into Chrome. Chrome 111 or newer.

**From the release zip**

1. Download the zip from the [latest release](https://github.com/mattmartinez/NoBreaks/releases/latest) and extract it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the extracted `NoBreaks` folder.

**From a clone**

1. `git clone https://github.com/mattmartinez/NoBreaks.git`
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the cloned `NoBreaks` folder.

To update, download the newer zip and load it the same way, or `git pull`. After a change to `manifest.json`, click the extension's reload button on `chrome://extensions`; the scripts themselves are picked up on the next page load.

## Files

- `adblock.js` runs inside the page, wraps the player worker and swaps playlists.
- `bridge.js` is a regular content script that relays settings between `chrome.storage` and the page.
- `popup/` is the toolbar popup: the notice toggle and the counter.

## License

GPL-3.0, see `LICENSE`. The playlist-swapping approach descends from the GPL-licensed "Twitch Adblock" extension.

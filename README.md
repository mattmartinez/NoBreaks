# NoBreaks

A small Chrome extension that skips Twitch ad breaks. When the live stream you're watching switches to server-side ads, NoBreaks swaps in an ad-free copy of the same stream and switches back when the break is over. Everything happens in the browser; the only requests it adds are the ones Twitch's own player would make for another player type.

## How it works

Twitch delivers live video over HLS: the stream is cut into segments of about two seconds, and a *playlist* is a small text file listing the most recent ones, which the player re-reads every couple of seconds to find out what is new. Ads are spliced into that list alongside the stream's own segments and marked with `stitched-ad` tags. The player cannot tell them apart, because both are ordinary video files from the same server, so there is nothing to block by hostname: the ad arrives inside the stream. [proxy/README.md](proxy/README.md) explains this in full. The player fetches its playlists from a web worker, so the extension wraps that worker, hooks `fetch` inside it and, whenever a playlist carries ads, requests the same stream as another player type (`embed`, then `thunderdome`, which is limited to 480p) and hands the player that playlist instead. A small "Skipping ad break..." notice is shown meanwhile and the skipped time is counted in the popup.

On some channels Twitch serves the ad markers to every player type and shows "Commercial break in progress". There is no ad-free variant to swap in, so the break is left alone unless you have set up a proxy.

## Enforced breaks and the optional proxy

Twitch used to serve no ads in some regions, so asking for the playlist from one of them was a way out when every player type carried the ad. NoBreaks can still do that through a proxy you run, but measurements on 2026-09-06 found no region where it helped: residential addresses in Russia, Poland and Kazakhstan all received the same ads across 12 live breaks. Test with `proxy/check-region.js` before spending money on this. See [proxy/README.md](proxy/README.md).

It is off by default and never contacted unless a break turns out to be enforced. Only the playlist is proxied, a few kilobytes every couple of seconds; the video itself still streams straight from Twitch, so the proxy needs almost no bandwidth and adds no buffering.

Set it in the popup as an https url with a `{channel}` placeholder, for example `https://your-host.example/playlist/{channel}.m3u8`, then reload the Twitch tab. The proxy has to return Twitch's master playlist and allow cross-origin reads (`Access-Control-Allow-Origin`), because the request is made by the page.

Two things worth knowing. The playlist it returns is for a logged-out session, so subscriber perks such as an ad-free experience you already pay for or a sub-only stream will not apply to the video. And the proxy sees which channel you are watching, so run your own rather than trusting a public one.

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
- `popup/` is the toolbar popup: the notice toggle, the counter and the proxy setting.

## License

GPL-3.0, see `LICENSE`. The playlist-swapping approach descends from the GPL-licensed "Twitch Adblock" extension.

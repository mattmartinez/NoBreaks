# NoBreaks

A Chrome extension that skips Twitch ad breaks by handing the player an ad-free copy of the same stream.

It works on channels where such a copy exists, and stays out of the way on channels where it does not. That second half matters: Twitch has closed most of the ways around its ads, and this README is honest about where the line now sits.

## What it does

While an ad plays, the playlist Twitch's player is reading lists ad segments instead of the stream. NoBreaks notices that, asks Twitch for the same channel as a different *player type* (`embed`, then `thunderdome`), and if that copy has no ads it hands the player that one instead. When the break is over it puts the player back. A small "Skipping ad break..." notice shows while this is happening, and the popup counts the time saved.

## What it cannot do

**Enforced breaks.** On many channels Twitch now marks every player type with the same ad. There is no clean copy to swap in, so NoBreaks leaves the stream alone and you see the ad, or Twitch's purple "Commercial break in progress" card, for the length of the break. This is not a bug and there is no setting that changes it.

**Client-side ads.** Some breaks are played by the player itself rather than baked into the stream. NoBreaks only rewrites playlists, so it cannot touch those. It deliberately does not interfere while one is on screen, because doing so used to freeze the player permanently.

**Region shopping no longer helps.** Ads used to be absent in some countries, so fetching the playlist from there was a way out. Measured on 2026-09-06 across 12 live ad breaks: residential addresses in Russia, Poland and Kazakhstan all received the same ads as a US connection, as did a datacenter address in Warsaw. Not one break came back clean anywhere, including on a Russian-language channel watched from a Russian residential address. The optional proxy support below is kept because the mechanism is sound, but do not spend money on it expecting it to work. See [proxy/README.md](proxy/README.md).

If you want ads gone on every channel, Twitch Turbo or a channel subscription are the things that actually do it.

## How it works

Twitch delivers live video over HLS. The stream is cut into segments of about two seconds, and a *playlist* is a small text file listing the most recent ones, which the player re-reads every couple of seconds to find out what is new. Ads are spliced into that list alongside the stream's own segments and marked with `stitched-ad` tags. The player cannot tell them apart, because both are ordinary video files from the same server, so there is nothing to block by hostname: the ad arrives inside the stream. [proxy/README.md](proxy/README.md) explains this in full.

The player fetches its playlists from a web worker, so the extension wraps the `Worker` constructor, hooks `fetch` inside it, and inspects every media playlist that goes past.

Two details exist because of bugs found while testing against live streams:

**The player is moved at most twice per break.** The ad marker flickers off for a single poll at the boundary between ad pods. Treating that as the end of the break, handing the player back, then moving it out again when the ad returns, starved the player until it paused itself. So once moved onto an alternate session the player stays there for the rest of the break, even if that session starts carrying ads too, and only returns after the normal stream has been clean twice in a row.

**The player is only nudged when Twitch is not showing an ad.** Handing the player back needs a pause and resume so it rejoins the live edge. Doing that while a client-side ad is on screen also pauses the ad, whose countdown then never finishes, and the stream locks up for good. The nudge now waits for the ad overlay to clear.

## Install

Either download the release zip or clone the repository, then load the folder into Chrome. Chrome 111 or newer. Chromium browsers such as Brave and Edge work too.

**From the release zip**

1. Download the zip from the [latest release](https://github.com/mattmartinez/NoBreaks/releases/latest) and extract it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the extracted `NoBreaks` folder.

**From a clone**

1. `git clone https://github.com/mattmartinez/NoBreaks.git`
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the cloned `NoBreaks` folder.

Loading the clone is worth it if you expect to update: `git pull` then click reload on the extension's card, rather than downloading a new zip each time. Content scripts are picked up on the next page load, so refresh the Twitch tab afterwards.

## Settings

Click the extension's toolbar icon.

- **Show "Skipping ad break..." over the player.** On by default. The counter runs either way.
- **Ads blocked.** Running total of skipped seconds.
- **Playlist proxy.** Off by default, and measured not to help; see above. If set, it must be an `https` url containing `{channel}`, and it is only ever contacted after the normal player types have already failed. Reload the Twitch tab after changing it.

## If you still see ads

Most likely the break is enforced, which is expected rather than broken. To tell the difference, open DevTools on the Twitch tab, filter the console for `NoBreaks`, and watch during a break:

- `hooked the player worker` on page load means the extension is running.
- `trying to skip ads as embed` means it found a break and is looking for a clean copy.
- `no ad-free stream available, leaving this break alone` means the break is enforced. Nothing more can be done for that break.
- No messages at all during an ad means either the extension is not running on that page, or the ad is client-side and never appeared in the playlist.

To check a channel directly, `proxy/check-region.js` reports whether Twitch is stitching ads into a given channel from wherever you run it.

## What you will see

The picture often drops in quality during and after a skip. The alternate copies do not always offer every resolution (`thunderdome` stops at 480p), and Twitch's own adaptive quality takes a while to climb back. That is the player's doing, not something the extension sets.

## Files

- `adblock.js` runs inside the page, wraps the player worker and swaps playlists.
- `bridge.js` is a regular content script relaying settings between `chrome.storage` and the page.
- `popup/` is the toolbar popup: the notice toggle, the counter and the proxy setting.
- `proxy/` is an optional playlist proxy you can run yourself, plus a script for testing whether a location is ad-free. Read its README before spending anything on it.

## Version history

- **1.1.2** Keep the break state when the player re-reads the master playlist, so the notice cannot be left showing after the break ends.
- **1.1.1** Move the player at most twice per break. Fixes the stream freezing when the ad marker flickers between pods.
- **1.1.0** Optional playlist proxy for enforced breaks.
- **1.0.2** Never nudge the player while Twitch is showing its own ad, which used to lock the stream up for good.
- **1.0.1** Hand the player back with a pause and resume so it rejoins the live edge.
- **1.0.0** First release.

## License

GPL-3.0, see `LICENSE`. The playlist-swapping approach descends from the GPL-licensed "Twitch Adblock" extension.

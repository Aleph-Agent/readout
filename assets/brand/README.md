# Brand assets

Rendered from HTML with the site's own tokens and fonts, so the account and the
product cannot drift apart. Regenerate after any palette change:

```sh
node scripts/build.ts   # fonts must exist in dist/fonts first
"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" `
  --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 `
  --window-size=1500,500 --screenshot=assets/brand/banner.png `
  --allow-file-access-from-files file:///.../assets/brand/banner.html
```

| File | Size | Where it goes |
|---|---|---|
| `banner.png` | 3000x1000 (2x of 1500x500) | X header |
| `avatar.png` | 800x800 (2x of 400x400) | X profile picture |

Rendered at 2x because X resamples down and a 1x asset arrives soft.

**Banner.** Content sits above the bottom-left corner, which X covers with the
avatar on a profile page, and inside the middle band, which is what survives
mobile cropping. The strip along the bottom is decorative there — it carries no
figure the reader would lose when the avatar lands on it.

**Avatar.** The only size that matters is 48px, which is where it is actually
seen. So it is one mark: a lime spike above a dashed baseline with four flat
readings beside it. No wordmark, no detail that exists only at full size, and
the baseline is drawn because a deviation with no visible reference is not a
measurement.

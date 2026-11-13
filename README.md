# Broadsheet

A Reddit reader built to use the whole iPad screen. Plain HTML/CSS/JS, no build step.

## Layout

| Screen | Layout |
| --- | --- |
| iPad landscape (≥1100px) | Subreddit sidebar, post list and post/comments side by side |
| iPad portrait / Split View | Post list and post/comments; sidebar slides in from the menu button |
| Slide Over / phone (<760px) | Single pane; post opens over the list |

- **Gallery mode** (grid button or `g`): posts fill the screen as a grid of large cards; a post opens full screen.
- **Full width** (expand button or `f`): hides the sidebar and list so the post and comments use the entire screen.
- **Resizable list**: drag the divider between list and post; double-click to reset.
- Installed to the Home Screen it runs standalone, edge to edge, with safe-area insets respected.

Other features: hot/new/top/rising/controversial with time ranges, subreddit and post search, user pages, favorites, threaded comments with collapse and "load more", image galleries, Reddit-hosted video (HLS), lightbox with tap-to-zoom, NSFW blur, light/dark themes, text size.

### Keyboard (Magic Keyboard)

`j`/`k` next/previous post · `Space` scroll post · `f` full width · `g` gallery · `r` refresh · `o` open link · `/` search · `Esc` back

## Install on iPad

1. Host the files over HTTPS (GitHub Pages workflow included: in the repository settings set **Pages → Source** to **GitHub Actions**, then push to `main`).
2. Open the URL in Safari, tap **Share → Add to Home Screen**.
3. Launch from the Home Screen icon.

To run locally: `python3 -m http.server 8000` and open `http://localhost:8000`.

## Reddit API access

By default the app reads Reddit's public JSON endpoints anonymously. If Reddit blocks those requests (posts fail to load with a 403 or network error):

1. Go to https://www.reddit.com/prefs/apps and create an app of type **installed app** (redirect URI can be any URL, e.g. `http://localhost`).
2. Copy the client ID (the string under the app name).
3. In Broadsheet, open **Settings** (gear icon) and paste it into **Reddit API client ID**.

The app then uses application-only OAuth against `oauth.reddit.com`. No password or account login is involved; the app is read-only.

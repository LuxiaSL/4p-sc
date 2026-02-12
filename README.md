# 4plebs Post Scraper

Browser-side scraper for [archive.4plebs.org](https://archive.4plebs.org) that pulls all your posts by username/tripcode and exports them in training-friendly formats.

Runs entirely in the browser — no server, no proxy, no Cloudflare bypass needed. Your existing browser session handles authentication.

## Files

| File | Purpose |
|------|---------|
| `scraper.js` | Core scraper module — can be used directly from the console |
| `index.html` | UI page that generates a ready-to-paste console script |

## Quick Start

### Option A: Use the UI (recommended)

1. Open `index.html` in your browser (just double-click it)
2. Fill in your username and/or tripcode
3. Click **Generate Console Script**
4. Click **Copy to Clipboard**
5. Open [archive.4plebs.org](https://archive.4plebs.org) in another tab
6. Open DevTools console (`F12` or `Cmd+Opt+J`)
7. Paste the script and press Enter
8. Wait — it paginates through all results with polite delays
9. Three files auto-download when complete

### Option B: Use scraper.js directly

1. Navigate to [archive.4plebs.org](https://archive.4plebs.org) in your browser
2. Open DevTools console
3. Copy-paste the contents of `scraper.js` into the console
4. Run:

```javascript
await run({
  username: 'YourName',
  tripcode: '!YourTrip',
  boards: 'x',          // or 'pol', 'x.pol.tv' for multiple, '' for all
})
```

## Output Formats

The scraper produces three files:

### `*_flat.json` — Flat array of normalized posts

```json
[
  {
    "post_id": "12345678",
    "thread_id": "12345000",
    "board": "x",
    "is_op": false,
    "timestamp": 1700000000,
    "date_iso": "2023-11-14T22:13:20.000Z",
    "name": "YourName",
    "tripcode": "!YourTrip",
    "subject": null,
    "text": "The cards are showing...",
    "has_media": true,
    "media_filename": "spread.jpg",
    "deleted": false
  }
]
```

### `*_threaded.json` — Posts grouped by thread

```json
[
  {
    "thread_id": "12345000",
    "board": "x",
    "posts": [ ... ]
  }
]
```

### `*_posts.jsonl` — One JSON object per line

Standard JSONL format for training pipelines. Each line is a complete post object.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `username` | `''` | Your poster name |
| `tripcode` | `''` | Your tripcode (include the `!` prefix) |
| `boards` | `'x'` | Board(s) to search. Dot-separate for multiple: `'x.pol.tv'` |
| `delayMs` | `13000` | Milliseconds between requests (keep >= 5000) |
| `startPage` | `1` | Page to start from (for resuming) |
| `maxRetries` | `3` | Retries per page on failure |

## How It Works

1. **Primary path**: Hits the FoolFuuka JSON API at `/_/api/chan/search/`
2. **Fallback**: If the API fails, falls back to fetching HTML search pages and parsing the DOM
3. **Rate limiting**: Defaults to one request every 13 seconds (under the ~5 req/min limit)
4. **Incremental saves**: Progress is saved to `localStorage` after every page, so if something breaks you can resume
5. **429 handling**: If the server returns `429 Too Many Requests`, the scraper reads the `Retry-After` header and waits accordingly

## Things to Verify When You Get to Your PC

These are the items that need real-browser testing:

- [ ] **Does the API endpoint actually work?** Navigate to `https://archive.4plebs.org/_/api/chan/search/?boards=x&username=YOUR_NAME&page=1` in your browser and check if you get JSON back. If it 403s, the DOM fallback should handle it.

- [ ] **JSON response shape**: The scraper expects `response["0"]["posts"]` to be an array. If 4plebs has changed their API envelope, the parsing will need adjustment. Check what the actual response looks like.

- [ ] **Tripcode format**: The API may want the tripcode with or without the `!` prefix. Try both if one doesn't return results: `!ABC123` vs `ABC123`.

- [ ] **DOM selectors**: If the DOM fallback is needed, verify these selectors still match 4plebs' current theme:
  - `article.post` for post containers
  - `.post_controls a` for post number/permalink
  - `.time_wrap time` for timestamp
  - `.text` for comment body
  - `.post_author` / `.post_tripcode` for identity

- [ ] **Pagination end detection**: The API should return `{"error": "..."}` when there are no more results. If it behaves differently (empty array, different key), the loop termination condition needs updating.

- [ ] **Cross-board search**: If you search multiple boards with `boards: 'x.pol'`, verify the dot-delimited format is what the API actually expects.

- [ ] **localStorage size**: If you have thousands of posts, `localStorage` (typically 5-10MB) might fill up during the incremental save. The scraper handles this gracefully (warns but continues), but you'll lose resume capability if it happens.

## Rate Limits

4plebs enforces approximately 5 requests per minute on the search endpoint. The default 13-second delay keeps you safely under this. Going faster risks:

- `429 Too Many Requests` responses (handled automatically)
- Temporary IP bans (not handled — you'd need to wait)

## For Training Use

The JSONL output is the most pipeline-friendly format. Each line is an independent JSON object that can be fed directly into most fine-tuning or RAG ingestion workflows.

The threaded JSON is useful if you want to preserve conversational context — e.g., seeing what prompted a particular reading or what follow-up discussion happened.

Key fields for training:
- `text` — the sanitized plain-text content of each post
- `timestamp` / `date_iso` — for temporal ordering
- `thread_id` — for grouping related posts
- `subject` — thread subjects (often null for replies)
- `is_op` — whether you started the thread

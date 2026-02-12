/**
 * 4plebs Post Scraper
 *
 * Browser-side scraper for 4plebs.org (FoolFuuka archive).
 * Runs from the browser console while on archive.4plebs.org,
 * which means Cloudflare cookies are already present.
 *
 * Supports:
 *  - JSON API endpoint (primary, structured data)
 *  - HTML DOM parsing (fallback if API is blocked)
 *  - Incremental saves to localStorage
 *  - Configurable rate limiting
 *  - Auto-download of results as JSON
 */

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  // Your identity — set these before running
  username: '',
  tripcode: '',

  // Boards to search. Use dot-delimited for multi-board: 'pol.x.tv'
  // Leave empty string for all archived boards.
  boards: 'x',

  // Rate limiting — 4plebs allows ~5 req/min on the search endpoint.
  // 13s between requests keeps us safely under that.
  delayMs: 13000,

  // Retry config for transient failures
  maxRetries: 3,
  retryBackoffMs: 5000,

  // Where to start pagination (useful for resuming interrupted scrapes)
  startPage: 1,

  // localStorage key for incremental saves
  storageKey: '4plebs_scrape_progress',
};

// ─── API Scraper ────────────────────────────────────────────────────────────

/**
 * Fetch a single page of search results from the JSON API.
 * Returns an array of post objects, or null if we've hit the end / an error.
 */
async function fetchApiPage(page) {
  const params = new URLSearchParams();
  if (CONFIG.boards) params.set('boards', CONFIG.boards);
  if (CONFIG.username) params.set('username', CONFIG.username);
  if (CONFIG.tripcode) params.set('tripcode', CONFIG.tripcode);
  params.set('page', page);

  const url = `/_/api/chan/search/?${params.toString()}`;

  const resp = await fetch(url, {
    credentials: 'same-origin',
    headers: {
      'Accept': 'application/json',
    },
  });

  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get('Retry-After') || '30', 10);
    console.warn(`[429] Rate limited. Waiting ${retryAfter}s as instructed by server...`);
    await sleep(retryAfter * 1000);
    return fetchApiPage(page); // retry after waiting
  }

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }

  const data = await resp.json();

  // End-of-results: API returns {"error": "..."} when no more posts
  if (data.error) {
    return null;
  }

  // Normal response shape: { "0": { "posts": [...] } }
  const bucket = data['0'] || data[0];
  if (!bucket || !bucket.posts || bucket.posts.length === 0) {
    return null;
  }

  return bucket.posts;
}

// ─── DOM Fallback Scraper ───────────────────────────────────────────────────

/**
 * Fetch a single page of search results by parsing the HTML search page.
 * Used as a fallback if the JSON API is unavailable.
 */
async function fetchDomPage(page) {
  // Build the path-based search URL
  let path = `/_/search`;
  if (CONFIG.username) path += `/username/${encodeURIComponent(CONFIG.username)}`;
  if (CONFIG.tripcode) path += `/tripcode/${encodeURIComponent(CONFIG.tripcode)}`;
  path += `/page/${page}/`;

  // If searching specific boards, use board prefix instead of _
  if (CONFIG.boards && !CONFIG.boards.includes('.')) {
    path = `/${CONFIG.boards}/search`;
    if (CONFIG.username) path += `/username/${encodeURIComponent(CONFIG.username)}`;
    if (CONFIG.tripcode) path += `/tripcode/${encodeURIComponent(CONFIG.tripcode)}`;
    path += `/page/${page}/`;
  }

  const resp = await fetch(path, { credentials: 'same-origin' });

  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get('Retry-After') || '30', 10);
    console.warn(`[429] Rate limited. Waiting ${retryAfter}s...`);
    await sleep(retryAfter * 1000);
    return fetchDomPage(page);
  }

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }

  const html = await resp.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const articles = doc.querySelectorAll('article.post');

  if (articles.length === 0) {
    return null;
  }

  const posts = [];
  for (const article of articles) {
    posts.push(parsePostFromDom(article));
  }
  return posts;
}

/**
 * Extract structured data from a single <article class="post"> element.
 */
function parsePostFromDom(article) {
  const getText = (sel) => {
    const el = article.querySelector(sel);
    return el ? el.textContent.trim() : null;
  };
  const getAttr = (sel, attr) => {
    const el = article.querySelector(sel);
    return el ? el.getAttribute(attr) : null;
  };

  // Extract doc_id from class list: "post doc_id_12345 ..."
  let docId = null;
  for (const cls of article.classList) {
    if (cls.startsWith('doc_id_')) {
      docId = cls.replace('doc_id_', '');
      break;
    }
  }

  // Post number from the permalink
  const postLink = article.querySelector('.post_controls a');
  let num = null;
  let threadNum = null;
  if (postLink) {
    const href = postLink.getAttribute('href') || '';
    // href looks like /board/thread/THREAD_NUM/#POST_NUM
    const match = href.match(/\/thread\/(\d+)\/#(\d+)/);
    if (match) {
      threadNum = match[1];
      num = match[2];
    } else {
      // fallback: just grab the text "No.12345"
      const numMatch = postLink.textContent.match(/No\.(\d+)/);
      if (numMatch) num = numMatch[1];
    }
  }

  // Board from the post link
  let board = null;
  if (postLink) {
    const href = postLink.getAttribute('href') || '';
    const boardMatch = href.match(/^\/(\w+)\//);
    if (boardMatch) board = boardMatch[1];
  }

  // Timestamp
  const timeEl = article.querySelector('.time_wrap time');
  const timestamp = timeEl ? timeEl.getAttribute('datetime') : null;
  const fourchanDate = timeEl ? timeEl.textContent.trim() : null;

  // Comment — get both HTML and text
  const commentEl = article.querySelector('.text');
  const commentHtml = commentEl ? commentEl.innerHTML.trim() : null;
  const commentText = commentEl ? commentEl.textContent.trim() : null;

  return {
    doc_id: docId,
    num: num,
    thread_num: threadNum,
    board: board,
    op: article.classList.contains('post_is_op') ? '1' : '0',
    timestamp: timestamp,
    fourchan_date: fourchanDate,
    name: getText('.post_author'),
    trip: getText('.post_tripcode'),
    title: getText('.post_title'),
    poster_hash: getText('.poster_hash'),
    comment: commentText,
    comment_html: commentHtml,
    media_url: getAttr('.thread_image_link', 'href'),
    thumb_url: getAttr('.post_image', 'src'),
    media_filename: getText('.post_file_filename'),
    _source: 'dom',
  };
}

// ─── Main Scraper Loop ──────────────────────────────────────────────────────

/**
 * Scrape all posts matching the configured username/tripcode.
 *
 * @param {object} opts
 * @param {boolean} opts.useApi  - true for JSON API (default), false for DOM fallback
 * @returns {Array} All scraped posts
 */
async function scrapeAllPosts(opts = {}) {
  const useApi = opts.useApi !== false;
  const fetchPage = useApi ? fetchApiPage : fetchDomPage;

  // Resume from localStorage if available
  let { posts, lastPage } = loadProgress();
  let page = lastPage > 0 ? lastPage : CONFIG.startPage;

  if (posts.length > 0) {
    console.log(`Resuming from page ${page} with ${posts.length} posts already saved.`);
  }

  console.log(`Starting scrape — method: ${useApi ? 'API' : 'DOM'}, boards: ${CONFIG.boards || 'all'}`);
  console.log(`Username: "${CONFIG.username}", Tripcode: "${CONFIG.tripcode}"`);

  let consecutiveErrors = 0;

  while (true) {
    let pagePosts = null;
    let attempt = 0;

    while (attempt <= CONFIG.maxRetries) {
      try {
        pagePosts = await fetchPage(page);
        consecutiveErrors = 0;
        break;
      } catch (err) {
        attempt++;
        consecutiveErrors++;
        console.error(`Error on page ${page} (attempt ${attempt}/${CONFIG.maxRetries + 1}):`, err.message);

        if (consecutiveErrors >= 5) {
          console.error('Too many consecutive errors. Stopping. Your progress has been saved.');
          saveProgress(posts, page);
          return posts;
        }

        if (attempt <= CONFIG.maxRetries) {
          const backoff = CONFIG.retryBackoffMs * attempt;
          console.log(`Retrying in ${backoff / 1000}s...`);
          await sleep(backoff);
        }
      }
    }

    // Null means end of results
    if (pagePosts === null) {
      console.log(`No more results after page ${page - 1}. Scrape complete.`);
      break;
    }

    posts.push(...pagePosts);
    console.log(`Page ${page}: ${pagePosts.length} posts (${posts.length} total)`);

    // Save incrementally
    saveProgress(posts, page + 1);

    page++;

    // Polite delay
    console.log(`Waiting ${CONFIG.delayMs / 1000}s before next request...`);
    await sleep(CONFIG.delayMs);
  }

  // Clear progress since we finished successfully
  clearProgress();

  console.log(`\nDone! Scraped ${posts.length} total posts.`);
  return posts;
}

// ─── Progress Persistence ───────────────────────────────────────────────────

function saveProgress(posts, nextPage) {
  try {
    localStorage.setItem(CONFIG.storageKey, JSON.stringify({
      posts,
      lastPage: nextPage,
      timestamp: Date.now(),
      config: { username: CONFIG.username, tripcode: CONFIG.tripcode, boards: CONFIG.boards },
    }));
  } catch (e) {
    // localStorage might be full for very large scrapes
    console.warn('Could not save to localStorage:', e.message);
  }
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(CONFIG.storageKey);
    if (!raw) return { posts: [], lastPage: 0 };

    const saved = JSON.parse(raw);
    // Only resume if the config matches
    if (
      saved.config &&
      saved.config.username === CONFIG.username &&
      saved.config.tripcode === CONFIG.tripcode &&
      saved.config.boards === CONFIG.boards
    ) {
      return { posts: saved.posts || [], lastPage: saved.lastPage || 0 };
    }
  } catch (e) {
    // Corrupted data, start fresh
  }
  return { posts: [], lastPage: 0 };
}

function clearProgress() {
  localStorage.removeItem(CONFIG.storageKey);
}

// ─── Post-Processing ────────────────────────────────────────────────────────

/**
 * Normalize raw API post objects into a clean, training-friendly format.
 * Works with both API and DOM-sourced posts.
 */
function normalizePosts(posts) {
  return posts.map(post => {
    // Determine the best text content field
    let text = post.comment_sanitized || post.comment || '';

    // Strip any residual HTML tags from text
    if (text.includes('<')) {
      const tmp = document.createElement('div');
      tmp.innerHTML = text;
      text = tmp.textContent || tmp.innerText || '';
    }

    // Clean up whitespace
    text = text.replace(/\s+/g, ' ').trim();

    // Determine board — API posts don't always have a direct board field,
    // but the search endpoint returns it in the post's board context
    const board = post.board?.shortname || post.board || null;

    return {
      // Identity
      post_id: post.num || null,
      thread_id: post.thread_num || null,
      board: board,
      is_op: post.op === '1' || post.op === 1,

      // Temporal
      timestamp: post.timestamp ? parseInt(post.timestamp, 10) : null,
      date_human: post.fourchan_date || null,
      date_iso: post.timestamp
        ? new Date(parseInt(post.timestamp, 10) * 1000).toISOString()
        : null,

      // Author
      name: post.name || null,
      tripcode: post.trip || null,
      poster_id: post.poster_hash || null,
      country: post.poster_country || null,

      // Content
      subject: post.title || null,
      text: text,
      text_html: post.comment_processed || post.comment_html || null,

      // Media
      has_media: !!(post.media || post.media_url),
      media_filename: post.media?.media_filename || post.media_filename || null,
      media_url: post.media?.media_link || post.media_url || null,
      thumb_url: post.media?.thumb_link || post.thumb_url || null,

      // Meta
      deleted: post.deleted === '1' || post.deleted === 1,
    };
  });
}

/**
 * Convert posts into a conversational/threaded structure,
 * grouping by thread for better training context.
 */
function groupByThread(normalizedPosts) {
  const threads = {};
  for (const post of normalizedPosts) {
    const tid = post.thread_id || 'unknown';
    if (!threads[tid]) {
      threads[tid] = {
        thread_id: tid,
        board: post.board,
        posts: [],
      };
    }
    threads[tid].posts.push(post);
  }

  // Sort posts within each thread by timestamp
  for (const thread of Object.values(threads)) {
    thread.posts.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }

  return Object.values(threads);
}

// ─── Export / Download ──────────────────────────────────────────────────────

/**
 * Trigger a browser download of data as a JSON file.
 */
function downloadJson(data, filename) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  console.log(`Downloaded: ${filename} (${(json.length / 1024).toFixed(1)} KB)`);
}

/**
 * Export in JSONL format (one JSON object per line) — useful for training pipelines.
 */
function downloadJsonl(posts, filename) {
  const lines = posts.map(p => JSON.stringify(p));
  const blob = new Blob([lines.join('\n')], { type: 'application/jsonl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  console.log(`Downloaded: ${filename} (${(lines.join('\n').length / 1024).toFixed(1)} KB)`);
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Public Interface ───────────────────────────────────────────────────────

/**
 * One-shot: configure, scrape, normalize, and download.
 *
 * Usage from browser console:
 *   await run({ username: 'YourName', tripcode: '!YourTrip', boards: 'x' })
 */
async function run(userConfig = {}) {
  // Apply user config
  Object.assign(CONFIG, userConfig);

  if (!CONFIG.username && !CONFIG.tripcode) {
    console.error('You must set at least a username or tripcode in the config.');
    console.log('Usage: await run({ username: "Name", tripcode: "!Trip", boards: "x" })');
    return;
  }

  console.log('=== 4plebs Post Scraper ===');
  console.log(`Scraping posts for: ${CONFIG.username || '(any)'}${CONFIG.tripcode || ''}`);
  console.log(`Board(s): ${CONFIG.boards || 'all'}`);
  console.log('');

  // Try API first, fall back to DOM
  let rawPosts;
  try {
    console.log('Attempting JSON API...');
    rawPosts = await scrapeAllPosts({ useApi: true });
  } catch (err) {
    console.warn('API scraping failed, falling back to DOM scraping:', err.message);
    rawPosts = await scrapeAllPosts({ useApi: false });
  }

  if (rawPosts.length === 0) {
    console.log('No posts found. Check your username/tripcode/board settings.');
    return [];
  }

  // Normalize
  const normalized = normalizePosts(rawPosts);
  const threaded = groupByThread(normalized);

  // Stats
  const boards = [...new Set(normalized.map(p => p.board).filter(Boolean))];
  const dateRange = normalized
    .map(p => p.timestamp)
    .filter(Boolean)
    .sort((a, b) => a - b);

  console.log('\n=== Scrape Summary ===');
  console.log(`Total posts: ${normalized.length}`);
  console.log(`Threads: ${threaded.length}`);
  console.log(`Boards: ${boards.join(', ') || 'unknown'}`);
  if (dateRange.length > 0) {
    console.log(`Date range: ${new Date(dateRange[0] * 1000).toISOString().split('T')[0]} → ${new Date(dateRange[dateRange.length - 1] * 1000).toISOString().split('T')[0]}`);
  }

  // Download all formats
  const nameSlug = (CONFIG.username || CONFIG.tripcode || 'anon').replace(/[^a-zA-Z0-9]/g, '_');
  downloadJson(normalized, `4plebs_${nameSlug}_flat.json`);
  downloadJson(threaded, `4plebs_${nameSlug}_threaded.json`);
  downloadJsonl(normalized, `4plebs_${nameSlug}_posts.jsonl`);

  console.log('\n3 files downloaded:');
  console.log('  *_flat.json    — flat array of normalized posts');
  console.log('  *_threaded.json — posts grouped by thread');
  console.log('  *_posts.jsonl  — one post per line (for training pipelines)');

  return normalized;
}

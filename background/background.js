import { fetchVideosForQueries, getVideoContext } from '../utils/youtube.js';
import { resolveSearchIntent, filterVideosByRelevance, getContextualQueries } from '../utils/gemini.js';

// Predefined search queries for preset modes
const PRESET_QUERIES = {
  motivation: [
    "motivational speech",
    "self improvement documentary",
    "mindset transformation",
    "success habits"
  ],
  study: [
    "university lecture",
    "programming tutorial",
    "science explainer",
    "deep dive documentary"
  ],
  music: [
    "official music video",
    "live concert",
    "album playlist",
    "music session"
  ],
  ai: [
    "large language models explained",
    "AI research paper",
    "machine learning tutorial",
    "AI news 2024"
  ]
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Initialize default settings on install or update, and reload YouTube tabs
chrome.runtime.onInstalled.addListener(async () => {
  // Only set default storage keys if they don't exist yet
  const keys = await chrome.storage.local.get(['skopeEnabled', 'skopeMode', 'skopeCustomTag']);
  if (keys.skopeEnabled === undefined) {
    await chrome.storage.local.set({
      skopeEnabled: true,
      skopeMode: 'motivation',
      skopeCustomTag: ''
    });
  }
  console.log('Skope installed/updated.');

  // Reload only the active YouTube tab(s) to avoid disrupting paused background tabs
  try {
    const tabs = await chrome.tabs.query({ url: "*://*.youtube.com/*", active: true });
    for (const tab of tabs) {
      chrome.tabs.reload(tab.id);
    }
  } catch (err) {
    console.error('Error reloading active YouTube tabs on update:', err);
  }
});

// Helper to notify all YouTube tabs about state changes
async function notifyYouTubeTabs(message) {
  try {
    const tabs = await chrome.tabs.query({ url: "*://*.youtube.com/*" });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {
        // Suppress errors for tabs without active content script
      });
    }
  } catch (err) {
    console.error('Error querying YouTube tabs:', err);
  }
}

// Helper to get cache key based on mode and tag
function getCacheKey(mode, customTag) {
  if (mode === 'custom') {
    const sanitizedTag = (customTag || '').trim().toLowerCase();
    return `skope_cache_custom_${encodeURIComponent(sanitizedTag)}`;
  }
  return `skope_cache_preset_${mode}`;
}

// Fetch feed data from cache or APIs
async function getFeedData(forceRefresh = false) {
  // Get active mode and custom tag
  const settings = await chrome.storage.local.get(['skopeEnabled', 'skopeMode', 'skopeCustomTag']);
  const enabled = settings.skopeEnabled !== false;
  const mode = settings.skopeMode || 'motivation';
  const customTag = settings.skopeCustomTag || '';

  if (!enabled) {
    return { enabled: false, mode, videos: [] };
  }

  const cacheKey = getCacheKey(mode, customTag);

  // 1. Check cache if not force refreshing
  if (!forceRefresh) {
    const cacheEntry = await chrome.storage.local.get(cacheKey);
    if (cacheEntry[cacheKey]) {
      const { videos, timestamp } = cacheEntry[cacheKey];
      const isExpired = Date.now() - timestamp > CACHE_TTL_MS;
      if (!isExpired && videos && videos.length > 0) {
        console.log(`Cache hit for ${cacheKey}`);
        return { enabled: true, mode, customTag, videos };
      }
    }
  }

  console.log(`Cache miss or refresh for ${cacheKey}. Fetching from API...`);

  // 2. Fetch fresh data based on mode
  let queries = [];
  let excludeTerms = [];

  if (mode === 'custom') {
    if (!customTag.trim()) {
      return { enabled: true, mode, customTag, videos: [] };
    }
    // Resolve intent and fetch smart queries/channels using Gemini
    const intent = await resolveSearchIntent(customTag);
    // Combine general queries and channel queries (searching for channel name specifically)
    queries = [
      ...intent.search_queries,
      ...intent.known_channels.map(c => `"${c.replace(/"/g, '')}"`)
    ];
    excludeTerms = intent.exclude_terms;
  } else {
    // Use preset queries
    queries = PRESET_QUERIES[mode] || PRESET_QUERIES['motivation'];
  }

  // Determine minViews threshold depending on the mode to filter out fakes & low-quality spam
  let minViews = 0;
  if (mode === 'music') {
    minViews = 10000;
  } else if (mode === 'motivation') {
    minViews = 5000;
  } else if (mode === 'custom') {
    const tagLower = (customTag || '').toLowerCase();
    // Check if custom tag is related to popular entertainment (music, artists, movies, shows)
    const isPopularTopic = [
      'music', 'song', 'sing', 'artist', 'rap', 'dj', 'band', 'concert', 'album',
      'drake', 'kanye', 'eminem', 'taylor swift', 'pop', 'hip hop', 'rock', 'beat',
      'movie', 'show', 'trailer', 'comedy', 'funny'
    ].some(term => tagLower.includes(term));

    minViews = isPopularTopic ? 10000 : 1000;
  } else {
    minViews = 500; // Low threshold for study and AI to allow niche educational videos
  }

  // Determine if this is a music-related search to bias toward music category videos (videoCategoryId=10)
  let videoCategoryId = '';
  if (mode === 'music') {
    videoCategoryId = '10';
  } else if (mode === 'custom') {
    const tagLower = (customTag || '').toLowerCase();
    const isMusicCustom = ['music', 'song', 'sing', 'artist', 'rap', 'dj', 'band', 'concert', 'album', 'drake', 'kanye', 'eminem', 'taylor swift', 'pop', 'hip hop', 'rock', 'beat'].some(term => tagLower.includes(term));
    if (isMusicCustom) {
      videoCategoryId = '10';
    }
  }

  // Fetch from YouTube Data API (fetch 50 results to ensure we have enough after filtering)
  let videos = await fetchVideosForQueries(queries, 50, minViews, videoCategoryId);

  // 3. Local first-pass filtering: Exclude lyrics, covers, karaoke, loops, and custom exclude terms
  const EXCLUDE_KEYWORDS = [
    'lyrics', 'lyric', 'cover', 'karaoke', 'tribute', 'fan made', 'type beat',
    'slowed', 'reverb', 'loop', '1 hour', 'reaction', 'mashup', 'remix'
  ];
  const finalExclude = [...EXCLUDE_KEYWORDS, ...excludeTerms];

  if (videos && videos.length > 0) {
    videos = videos.filter(v => {
      const titleLower = (v.title || '').toLowerCase();
      const channelLower = (v.channelTitle || '').toLowerCase();
      const descLower = (v.description || '').toLowerCase();
      
      const isNoise = finalExclude.some(term => 
        titleLower.includes(term) || 
        channelLower.includes(term) || 
        descLower.includes(term)
      );
      return !isNoise;
    });
  }

  // 4. Run secondary quality & relevance filtering pass via Gemini (filtering up to 50 candidates)
  if (videos && videos.length > 0) {
    const queryForFilter = mode === 'custom' ? customTag : PRESET_QUERIES[mode]?.[0] || mode;
    videos = await filterVideosByRelevance(queryForFilter, videos);
  }

  // 5. Cache the final filtered results if we got any
  if (videos && videos.length > 0) {
    await chrome.storage.local.set({
      [cacheKey]: {
        videos,
        timestamp: Date.now()
      }
    });
  }

  return { enabled: true, mode, customTag, videos };
}

// Session watch history to pass to Gemini
let watchHistory = [];

/**
 * Generates contextually relevant recommendations based on the active video, watch history, and focus mode.
 */
async function getContextualFeedData(videoId, forceRefresh = false) {
  const settings = await chrome.storage.local.get(['skopeEnabled', 'skopeMode', 'skopeCustomTag']);
  const enabled = settings.skopeEnabled !== false;
  const mode = settings.skopeMode || 'motivation';
  const customTag = settings.skopeCustomTag || '';

  if (!enabled) {
    return { enabled: false, mode, videos: [] };
  }

  const cacheKey = `recs_${videoId}_${mode}`;

  // 1. Check cache first
  if (!forceRefresh) {
    const cacheEntry = await chrome.storage.local.get(cacheKey);
    if (cacheEntry[cacheKey]) {
      const { videos, timestamp } = cacheEntry[cacheKey];
      const isExpired = Date.now() - timestamp > CACHE_TTL_MS;
      if (!isExpired && videos && videos.length > 0) {
        console.log(`Cache hit for contextual recommendations: ${cacheKey}`);
        return { enabled: true, mode, customTag, videos };
      }
    }
  }

  // 2. Fetch video metadata context
  const videoContext = await getVideoContext(videoId);
  if (!videoContext) {
    // Fall back to default mode feed if metadata fetch fails
    return getFeedData(forceRefresh);
  }

  // 3. Maintain watch history (up to 3 items)
  const exists = watchHistory.some(h => h.title === videoContext.title);
  if (!exists) {
    watchHistory.push(videoContext);
    if (watchHistory.length > 3) {
      watchHistory.shift();
    }
  }

  console.log(`Contextual Cache miss. Resolving query intent via Gemini for: "${videoContext.title}"`);

  // 4. Resolve contextual queries and channels via Gemini
  const contextualData = await getContextualQueries(videoContext, watchHistory, mode);

  // Combine queries and channels
  const queries = [
    ...contextualData.search_queries,
    ...contextualData.known_channels.map(c => `"${c.replace(/"/g, '')}"`)
  ];

  // 5. Determine minViews threshold depending on the mode to filter out fakes & low-quality spam
  let minViews = 0;
  if (mode === 'music') {
    minViews = 10000;
  } else if (mode === 'motivation') {
    minViews = 5000;
  } else if (mode === 'custom') {
    const tagLower = (customTag || '').toLowerCase();
    const isPopularTopic = [
      'music', 'song', 'sing', 'artist', 'rap', 'dj', 'band', 'concert', 'album',
      'drake', 'kanye', 'eminem', 'taylor swift', 'pop', 'hip hop', 'rock', 'beat',
      'movie', 'show', 'trailer', 'comedy', 'funny'
    ].some(term => tagLower.includes(term));
    minViews = isPopularTopic ? 10000 : 1000;
  } else {
    minViews = 500;
  }

  // Determine if this is a music-related search to bias toward music category videos
  let videoCategoryId = '';
  if (mode === 'music') {
    videoCategoryId = '10';
  } else if (mode === 'custom') {
    const tagLower = (customTag || '').toLowerCase();
    const isMusicCustom = ['music', 'song', 'sing', 'artist', 'rap', 'dj', 'band', 'concert', 'album', 'drake', 'kanye', 'eminem', 'taylor swift', 'pop', 'hip hop', 'rock', 'beat'].some(term => tagLower.includes(term));
    const titleLower = videoContext.title.toLowerCase();
    if (isMusicCustom || titleLower.includes('music') || titleLower.includes('song') || (videoContext.tags && videoContext.tags.some(t => t.toLowerCase().includes('music')))) {
      videoCategoryId = '10';
    }
  }

  // 6. Fetch from YouTube Data API (up to 50 results)
  let videos = await fetchVideosForQueries(queries, 50, minViews, videoCategoryId);

  // 7. Local first-pass filtering: Exclude lyrics, covers, loops, and custom exclude terms
  const EXCLUDE_KEYWORDS = [
    'lyrics', 'lyric', 'cover', 'karaoke', 'tribute', 'fan made', 'type beat',
    'slowed', 'reverb', 'loop', '1 hour', 'reaction', 'mashup', 'remix'
  ];
  const finalExclude = [...EXCLUDE_KEYWORDS, ...(contextualData.exclude_terms || [])];

  if (videos && videos.length > 0) {
    videos = videos.filter(v => {
      const titleLower = (v.title || '').toLowerCase();
      const channelLower = (v.channelTitle || '').toLowerCase();
      const descLower = (v.description || '').toLowerCase();
      
      const isNoise = finalExclude.some(term => 
        titleLower.includes(term) || 
        channelLower.includes(term) || 
        descLower.includes(term)
      );
      return !isNoise;
    });
  }

  // 8. Run quality & relevance filtering pass via Gemini (filtering up to 50 candidates)
  if (videos && videos.length > 0) {
    const queryForFilter = `${mode} related to ${videoContext.title} by ${videoContext.channel}`;
    videos = await filterVideosByRelevance(queryForFilter, videos);
  }

  // 8. Cache final filtered recommendations
  if (videos && videos.length > 0) {
    await chrome.storage.local.set({
      [cacheKey]: {
        videos,
        timestamp: Date.now()
      }
    });
  }

  return { enabled: true, mode, customTag, videos };
}

// Message router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GET_CONTEXTUAL_RECS') {
    getContextualFeedData(message.videoId, message.forceRefresh === true)
      .then(sendResponse)
      .catch(err => {
        console.error('Error in GET_CONTEXTUAL_RECS handler:', err);
        sendResponse({ enabled: true, videos: [], error: err.message });
      });
    return true; // Keep message channel open for async response
  }

  if (message.action === 'GET_FEED') {
    getFeedData(message.forceRefresh === true)
      .then(sendResponse)
      .catch(err => {
        console.error('Error in GET_FEED handler:', err);
        sendResponse({ enabled: true, videos: [], error: err.message });
      });
    return true; // Keep message channel open for async response
  }

  if (message.action === 'REFRESH_FEED') {
    // Query the active YouTube tab to trigger its local context-aware page refresh
    chrome.tabs.query({ url: "*://*.youtube.com/*", active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'TRIGGER_PAGE_REFRESH' })
          .then(() => sendResponse({ success: true }))
          .catch(err => {
            console.warn('Failed to message active tab for refresh, falling back to background refresh:', err);
            // Fallback: background refresh of default feed
            getFeedData(true)
              .then(res => {
                notifyYouTubeTabs({ action: 'FEED_UPDATED', data: res });
                sendResponse(res);
              });
          });
      } else {
        // Fallback: background refresh of default feed if no active YouTube tab is active
        getFeedData(true)
          .then(res => {
            notifyYouTubeTabs({ action: 'FEED_UPDATED', data: res });
            sendResponse(res);
          });
      }
    });
    return true; // Keep channel open for async response
  }

  if (message.action === 'STATE_CHANGED') {
    // Triggered by popup to tell background (and tabs) that settings changed
    getFeedData(false)
      .then(response => {
        notifyYouTubeTabs({ action: 'FEED_UPDATED', data: response });
        sendResponse({ success: true });
      })
      .catch(err => {
        console.error('Error in STATE_CHANGED handler:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }
});

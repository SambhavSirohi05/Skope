import { getConfig } from '../config.js';

/**
 * Helper to fetch a resource with a timeout.
 * 
 * @param {string} url 
 * @param {Object} options 
 * @param {number} timeoutMs 
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 3500) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

/**
 * Safely parses a JSON string, stripping markdown code block formatting if present.
 * 
 * @param {string} text 
 * @param {any} fallback 
 * @returns {any}
 */
function safeJsonParse(text, fallback) {
  if (!text) return fallback;
  let cleanText = text.trim();
  
  if (cleanText.startsWith('```')) {
    cleanText = cleanText.replace(/^```(?:json)?\n?/, '');
    cleanText = cleanText.replace(/\n?```$/, '');
    cleanText = cleanText.trim();
  }
  
  try {
    return JSON.parse(cleanText);
  } catch (e) {
    console.error('Failed to parse JSON response:', e, text);
    return fallback;
  }
}

/**
 * Resolves search intent from a custom tag using Gemini 1.5 Flash.
 * Culturally expands the tag into specific queries, known channels, and terms to exclude.
 * 
 * @param {string} tag - The user custom focus tag.
 * @returns {Promise<{search_queries: string[], known_channels: string[], exclude_terms: string[]}>}
 */
export async function resolveSearchIntent(tag) {
  if (!tag || !tag.trim()) {
    return { search_queries: [], known_channels: [], exclude_terms: [] };
  }

  const trimmedTag = tag.trim();
  const fallback = {
    search_queries: [trimmedTag, `${trimmedTag} tutorial`, `${trimmedTag} documentary`],
    known_channels: [],
    exclude_terms: ['parody', 'reaction', 'review', 'cover']
  };

  try {
    const config = await getConfig();
    const GEMINI_API_KEY = config.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `You are a YouTube search expert. A user wants to search for: "${trimmedTag}".
                Analyze what this topic culturally means. Understand associated artists, genres, popular channels, and playlists.
                
                Generate a structured JSON output with:
                1. "search_queries": 4 to 5 highly specific YouTube search queries that will retrieve high-quality, popular videos.
                2. "known_channels": 2 to 3 well-known, high-quality YouTube channels or artists associated with this topic (e.g. "Lofi Girl" for lofi music, "DrakeVEVO" or "OVO Sound" for Drake).
                3. "exclude_terms": 3 to 4 terms to avoid (e.g. "parody", "reaction", "review", "cover", "drama").
                
                Return the result strictly as a JSON object matching this structure:
                {
                  "understanding": "brief description of intent",
                  "search_queries": ["query1", "query2"],
                  "known_channels": ["channel1", "channel2"],
                  "exclude_terms": ["term1", "term2"]
                }
                Do not include markdown blocks or backticks. Return ONLY the JSON object.`
              }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: 'application/json'
        }
      })
    }, 3500);

    if (!response.ok) {
      console.warn('Gemini intent resolution failed:', response.status);
      return fallback;
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) return fallback;

    const parsed = safeJsonParse(rawText, fallback);
    return {
      search_queries: Array.isArray(parsed.search_queries) ? parsed.search_queries : fallback.search_queries,
      known_channels: Array.isArray(parsed.known_channels) ? parsed.known_channels : fallback.known_channels,
      exclude_terms: Array.isArray(parsed.exclude_terms) ? parsed.exclude_terms : fallback.exclude_terms
    };
  } catch (error) {
    console.error('Error resolving intent via Gemini:', error);
    return fallback;
  }
}

/**
 * Filters a list of candidate videos for quality and relevance using Gemini 1.5 Flash.
 * 
 * @param {string} userQuery - The initial query/focus topic typed by the user.
 * @param {Object[]} videos - List of video objects.
 * @returns {Promise<Object[]>} Filtered list of video objects.
 */
export async function filterVideosByRelevance(userQuery, videos) {
  if (!videos || videos.length === 0) return [];

  // Prepare a list of indices, titles, and channels for Gemini to analyze
  const videoDetails = videos.map((v, i) => `${i}: Title: "${v.title}" by Channel: "${v.channelTitle}"`).join('\n');

  try {
    const config = await getConfig();
    const GEMINI_API_KEY = config.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `A user wants to find high-quality, authentic YouTube videos for the topic/query: "${userQuery}".
                
                Here is a list of candidate video results (index, title, and channel):
                ${videoDetails}
                
                Analyze the list and select the indices of videos that:
                1. Are highly relevant to the query/topic.
                2. Are from credible, authentic, or official sources (avoid low-quality fan mashups, low-effort re-uploads, review videos, reaction videos, or parodies, unless the query explicitly asks for them).
                
                Return the list of accepted indices strictly as a JSON array of numbers, e.g. [0, 2, 5].
                Do not include markdown blocks or backticks. Return ONLY the JSON array.`
              }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: 'application/json'
        }
      })
    }, 4000);

    if (!response.ok) {
      console.warn('Gemini relevance filtering failed:', response.status);
      return videos;
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) return videos;

    const acceptedIndices = safeJsonParse(rawText, null);
    if (Array.isArray(acceptedIndices)) {
      const filtered = videos.filter((_, index) => acceptedIndices.includes(index));
      console.log(`Gemini filtered out ${videos.length - filtered.length} videos. Left with ${filtered.length}.`);
      
      // Safety fallback: if everything is filtered out, return original list rather than a blank screen
      return filtered.length > 0 ? filtered : videos;
    }
    
    return videos;
  } catch (error) {
    console.error('Error filtering videos via Gemini:', error);
    return videos;
  }
}

/**
 * Resolves watch page recommendations queries using current video context, watch history, and active focus mode.
 * 
 * @param {Object} videoContext - Current video metadata {title, channel, tags, description}.
 * @param {Object[]} watchHistory - List of recently watched video contexts.
 * @param {string} activeMode - Active focus mode.
 * @returns {Promise<{search_queries: string[], known_channels: string[], vibe: string}>}
 */
export async function getContextualQueries(videoContext, watchHistory, activeMode) {
  const fallback = {
    search_queries: [`${videoContext.channel} music`, `${activeMode}`],
    known_channels: [videoContext.channel],
    vibe: "Continuing the focus vibe."
  };

  try {
    const config = await getConfig();
    const GEMINI_API_KEY = config.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    
    // Format history
    let historyText = '';
    if (watchHistory && watchHistory.length > 1) {
      historyText = `The user has watched in this session:\n` +
        watchHistory.slice(0, -1).map((h, i) => `${i + 1}. Title: "${h.title}" by "${h.channel}"`).join('\n') +
        `\nAnd they just clicked on: "${videoContext.title}" by "${videoContext.channel}"`;
    } else {
      historyText = `The user just clicked on: "${videoContext.title}" by "${videoContext.channel}"`;
    }

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `You are a YouTube recommendations expert. The user is in "${activeMode}" focus mode.
                
                ${historyText}
                Current Video Tags: ${videoContext.tags ? videoContext.tags.join(', ') : 'none'}
                
                Your job is to figure out what they'd genuinely want to watch NEXT. Think in layers:
                
                Layer 1 — Same artist, different songs/content (e.g. other songs by this creator, not the current title again)
                Layer 2 — Same era / same vibe (e.g. similar release years, vibe, or speed)
                Layer 3 — Adjacent creators / artists in the same bubble
                Layer 4 — Same genre/niche rabbit hole
                
                RULES:
                - Never search for the exact video they just watched.
                - Never search for "lyrics", "cover", "reaction", or "karaoke" versions — target originals and official releases.
                - Spread search queries across all 4 layers.
                - Prioritize official channels, artists, and verified creators.
                - Return the result strictly as a JSON object matching this structure:
                {
                  "search_queries": ["query for layer 1", "query for layer 2", "query for layer 3", "query for layer 4"],
                  "known_channels": ["officialChannel1", "officialChannel2"],
                  "exclude_terms": ["lyrics", "${videoContext.title}"]
                }
                Do not include markdown blocks or backticks. Return ONLY the JSON object.`
              }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: 'application/json'
        }
      })
    }, 4000);

    if (!response.ok) {
      console.warn('Gemini contextual queries call failed:', response.status);
      return fallback;
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) return fallback;

    const parsed = safeJsonParse(rawText, fallback);
    return {
      search_queries: Array.isArray(parsed.search_queries) ? parsed.search_queries : fallback.search_queries,
      known_channels: Array.isArray(parsed.known_channels) ? parsed.known_channels : fallback.known_channels,
      exclude_terms: Array.isArray(parsed.exclude_terms) ? parsed.exclude_terms : fallback.exclude_terms
    };
  } catch (error) {
    console.error('Error getting contextual queries via Gemini:', error);
    return fallback;
  }
}

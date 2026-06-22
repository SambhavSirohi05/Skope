import { getConfig } from '../config.js';

/**
 * Parses YouTube ISO 8601 duration format (e.g., PT1H2M10S, PT4M13S) into standard format and returns seconds.
 * 
 * @param {string} durationStr 
 * @returns {{totalSeconds: number, formatted: string}}
 */
function parseDuration(durationStr) {
  if (!durationStr) return { totalSeconds: 0, formatted: '0:00' };
  
  const match = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return { totalSeconds: 0, formatted: '0:00' };

  const hours = parseInt(match[1] || 0, 10);
  const minutes = parseInt(match[2] || 0, 10);
  const seconds = parseInt(match[3] || 0, 10);

  const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;

  let formatted = '';
  if (hours > 0) {
    formatted += hours + ':' + String(minutes).padStart(2, '0') + ':';
  } else {
    formatted += minutes + ':';
  }
  formatted += String(seconds).padStart(2, '0');

  return { totalSeconds, formatted };
}

/**
 * Formats view count into a clean, short string (e.g., 1.2M views, 45K views).
 * 
 * @param {string} viewsStr 
 * @returns {string}
 */
function formatViews(viewsStr) {
  if (!viewsStr) return 'No views';
  const views = parseInt(viewsStr, 10);
  if (isNaN(views)) return 'No views';
  
  if (views >= 1000000) {
    return (views / 1000000).toFixed(1).replace(/\.0$/, '') + 'M views';
  }
  if (views >= 1000) {
    return (views / 1000).toFixed(1).replace(/\.0$/, '') + 'K views';
  }
  return views + ' views';
}

/**
 * Formats date string into a relative time (e.g., 3 days ago, 2 weeks ago).
 * 
 * @param {string} dateStr 
 * @returns {string}
 */
function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);
  
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

/**
 * Fetches videos matching search queries, retrieves their duration details,
 * filters out Shorts (< 60s), and returns normalized results.
 * 
 * Performs separate search requests for each query to acquire a large, diverse candidate
 * pool, then batch-requests video details in groups of 50 to maintain high efficiency.
 * 
 * @param {string[]} queries - Array of search queries.
 * @param {number} maxResults - Max search results to fetch per query (default 50).
 * @param {number} minViews - Minimum views required to show the video.
 * @returns {Promise<Object[]>} Normalized list of video objects.
 */
export async function fetchVideosForQueries(queries, maxResults = 50, minViews = 0) {
  if (!queries || queries.length === 0) return [];

  try {
    const config = await getConfig();
    const YOUTUBE_API_KEY = config.YOUTUBE_API_KEY;
    // 1. Fetch search results for each query in parallel (multi-querying)
    const searchPromises = queries.map(async (query) => {
      const cleanQuery = query.replace(/"/g, '').trim();
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?key=${YOUTUBE_API_KEY}&part=snippet&q=${encodeURIComponent(cleanQuery)}&type=video&videoEmbeddable=true&maxResults=${maxResults}&relevanceLanguage=en`;
      
      try {
        const response = await fetch(searchUrl);
        if (!response.ok) {
          console.warn(`Search for query "${cleanQuery}" failed with status: ${response.status}`);
          return [];
        }
        const data = await response.json();
        return data.items || [];
      } catch (err) {
        console.error(`Error searching query "${cleanQuery}":`, err);
        return [];
      }
    });

    const searchResultsArrays = await Promise.all(searchPromises);
    
    // Flatten and deduplicate search items by videoId
    const seenIds = new Set();
    const uniqueSearchItems = [];
    
    searchResultsArrays.flat().forEach(item => {
      const videoId = item.id?.videoId;
      if (videoId && !seenIds.has(videoId)) {
        seenIds.add(videoId);
        uniqueSearchItems.push(item);
      }
    });

    if (uniqueSearchItems.length === 0) return [];

    // Extract video IDs for follow-up details call
    const allVideoIds = uniqueSearchItems.map(item => item.id.videoId);

    // 2. Fetch duration and stats in batches of 50 (since videos endpoint accepts max 50 IDs)
    const detailsMap = {};
    const batchSize = 50;
    const detailsPromises = [];
    
    for (let i = 0; i < allVideoIds.length; i += batchSize) {
      const batchIds = allVideoIds.slice(i, i + batchSize);
      const videosUrl = `https://www.googleapis.com/youtube/v3/videos?key=${YOUTUBE_API_KEY}&part=contentDetails,statistics&id=${batchIds.join(',')}`;
      
      detailsPromises.push(
        fetch(videosUrl)
          .then(res => res.ok ? res.json() : null)
          .then(data => {
            if (data && data.items) {
              data.items.forEach(video => {
                detailsMap[video.id] = {
                  duration: video.contentDetails?.duration,
                  viewCount: video.statistics?.viewCount
                };
              });
            }
          })
          .catch(err => console.error('Error fetching batch video details:', err))
      );
    }

    await Promise.all(detailsPromises);

    // 3. Map search items to detailed format and filter out Shorts (< 60s) & low-view videos
    const normalizedVideos = uniqueSearchItems
      .map(item => {
        const videoId = item.id.videoId;
        const snippet = item.snippet;
        const details = detailsMap[videoId] || {};
        
        const { totalSeconds, formatted: formattedDuration } = parseDuration(details.duration);
        const viewCountNum = parseInt(details.viewCount || 0, 10);
        
        return {
          id: videoId,
          title: snippet.title,
          description: snippet.description,
          thumbnail: snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url,
          channelTitle: snippet.channelTitle,
          channelId: snippet.channelId,
          publishedAt: snippet.publishedAt,
          relativeTime: formatRelativeTime(snippet.publishedAt),
          durationSeconds: totalSeconds,
          durationFormatted: formattedDuration,
          viewCount: viewCountNum,
          viewsFormatted: formatViews(details.viewCount),
          videoUrl: `https://www.youtube.com/watch?v=${videoId}`
        };
      })
      .filter(video => video.durationSeconds >= 60 && video.viewCount >= minViews);

    return normalizedVideos;
  } catch (error) {
    console.error('Error fetching videos from YouTube:', error);
    return [];
  }
}

/**
 * Fetches context metadata (title, channel, tags, description) for a specific video ID.
 * 
 * @param {string} videoId 
 * @returns {Promise<{title: string, channel: string, description: string, tags: string[]}>}
 */
export async function getVideoContext(videoId) {
  try {
    const config = await getConfig();
    const YOUTUBE_API_KEY = config.YOUTUBE_API_KEY;
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${YOUTUBE_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`YouTube API returned status ${response.status}`);
    }
    const data = await response.json();
    const item = data.items?.[0];
    if (!item) {
      throw new Error('Video not found');
    }
    const snippet = item.snippet || {};
    return {
      title: snippet.title || '',
      channel: snippet.channelTitle || '',
      description: (snippet.description || '').slice(0, 300),
      tags: snippet.tags || []
    };
  } catch (error) {
    console.error('Error fetching video context:', error);
    return null;
  }
}

// Global configuration states
let skopeEnabled = true;
let skopeMode = 'motivation';
let skopeCustomTag = '';

// Contextual recommendations tracking
let lastVideoId = '';

// Pagination variables for infinite scroll feed
let allVideos = [];
let renderedVideos = [];

// Mapping from modes to readable text and emojis
const MODE_INFO = {
  motivation: { name: 'Motivation', emoji: '🎯' },
  study: { name: 'Study', emoji: '📚' },
  music: { name: 'Music', emoji: '🎵' },
  ai: { name: 'AI', emoji: '🤖' },
  custom: { name: 'Custom Focus', emoji: '✨' }
};

// Initialize settings and DOM handling on startup
chrome.storage.local.get(['skopeEnabled', 'skopeMode', 'skopeCustomTag'], (settings) => {
  skopeEnabled = settings.skopeEnabled !== false;
  skopeMode = settings.skopeMode || 'motivation';
  skopeCustomTag = settings.skopeCustomTag || '';

  if (skopeEnabled) {
    document.documentElement.setAttribute('skope-active', 'true');
    initSkope();
  } else {
    document.documentElement.removeAttribute('skope-active');
  }
});

// Listen for messages from background/popup
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'FEED_UPDATED') {
    const data = message.data;
    skopeEnabled = data.enabled;
    skopeMode = data.mode;
    skopeCustomTag = data.customTag;
    
    // Clear tracking ID so that mode changes force a fresh recommendations fetch
    lastVideoId = '';

    if (skopeEnabled) {
      document.documentElement.setAttribute('skope-active', 'true');
      updateUI(data.videos);
    } else {
      document.documentElement.removeAttribute('skope-active');
      removeSkopeElements();
    }
  }
});

// Setup SPA listeners and DOM observer
function initSkope() {
  // Listen for YouTube SPA navigation events
  window.addEventListener('yt-navigate-finish', handlePageChange);
  
  // Listen for scroll events to support smooth client-side infinite scroll
  window.addEventListener('scroll', handleScroll, { passive: true });
  
  // Observe DOM changes to handle dynamically rendered elements
  const observer = new MutationObserver(() => {
    if (!skopeEnabled) return;
    handlePageChange();
  });
  
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });

  handlePageChange();
}

// Route to correct page injection
function handlePageChange() {
  if (!skopeEnabled) return;

  const url = window.location.href;
  
  if (url === 'https://www.youtube.com/' || url.startsWith('https://www.youtube.com/?') || window.location.pathname === '/') {
    // We are on Homepage
    handleHomepageInjection();
  } else if (url.includes('/watch')) {
    // We are on Watch page
    handleWatchpageInjection();
  } else {
    // Other pages (search, shorts, etc) - remove Skope overlays if any
    removeSkopeElements();
  }
}

// --- HOMEPAGE INJECTION LOGIC ---
function handleHomepageInjection() {
  // Hide native feed (scoped to home browse page)
  const nativeFeed = document.querySelector('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer');
  if (nativeFeed) {
    nativeFeed.classList.add('skope-hidden');
  }

  // Ensure target container exists specifically for the homepage
  const primaryDiv = document.querySelector('ytd-browse[page-subtype="home"] #primary');
  if (!primaryDiv) return;

  // Clean up watch page sidebar to prevent layout leaks
  const oldSidebar = document.getElementById('skope-sidebar');
  if (oldSidebar) oldSidebar.remove();

  let skopeFeed = document.getElementById('skope-feed');
  
  // If it doesn't exist or is detached from the active homepage primary container
  const isDetached = skopeFeed && !primaryDiv.contains(skopeFeed);

  if (!skopeFeed || isDetached) {
    if (skopeFeed) skopeFeed.remove(); // Clean up if detached
    
    skopeFeed = document.createElement('div');
    skopeFeed.id = 'skope-feed';
    primaryDiv.appendChild(skopeFeed);
    
    // Trigger loading skeleton first
    renderSkeletonFeed();
    
    // Fetch actual feed data from background
    chrome.runtime.sendMessage({ action: 'GET_FEED' }, (response) => {
      if (response && response.videos) {
        updateUI(response.videos);
      }
    });
  }
}

// --- WATCH PAGE INJECTION LOGIC ---
function handleWatchpageInjection() {
  // Hide native recommendations specifically on the watch page
  const nativeSecondary = document.querySelector('ytd-watch-flexy #secondary ytd-watch-next-secondary-results-renderer');
  if (nativeSecondary) {
    nativeSecondary.classList.add('skope-hidden');
  }

  // Find target sidebar container specifically on the watch page
  const secondaryInner = document.querySelector('ytd-watch-flexy #secondary-inner') || document.querySelector('ytd-watch-flexy #secondary');
  if (!secondaryInner) return;

  const urlParams = new URLSearchParams(window.location.search);
  const videoId = urlParams.get('v');
  if (!videoId) return;

  // Clean up homepage feed to prevent layout leaks
  const oldFeed = document.getElementById('skope-feed');
  if (oldFeed) oldFeed.remove();

  let skopeSidebar = document.getElementById('skope-sidebar');
  
  // If it doesn't exist or is detached from the active sidebar container, or if a new video has been loaded
  const isDetached = skopeSidebar && !secondaryInner.contains(skopeSidebar);
  const isNewVideo = lastVideoId !== videoId;

  if (!skopeSidebar || isDetached || isNewVideo) {
    if (skopeSidebar) skopeSidebar.remove();
    
    lastVideoId = videoId; // Update tracking ID
    
    skopeSidebar = document.createElement('div');
    skopeSidebar.id = 'skope-sidebar';
    secondaryInner.appendChild(skopeSidebar);

    // Trigger loading skeleton
    renderSkeletonSidebar();

    // Fetch contextual recommendations based on current video and watch history
    chrome.runtime.sendMessage({ action: 'GET_CONTEXTUAL_RECS', videoId: videoId }, (response) => {
      if (response && response.videos) {
        updateUI(response.videos);
      }
    });
  }
}

// --- UPDATE UI WITH DATA ---
function updateUI(videos) {
  if (!skopeEnabled) return;

  const url = window.location.href;
  const isHome = url === 'https://www.youtube.com/' || url.startsWith('https://www.youtube.com/?') || window.location.pathname === '/';
  
  if (isHome) {
    renderHomepageFeed(videos);
  } else if (url.includes('/watch')) {
    renderWatchpageSidebar(videos);
  }
}

// Render Homepage grid
function renderHomepageFeed(videos) {
  const skopeFeed = document.getElementById('skope-feed');
  if (!skopeFeed) return;

  const modeObj = MODE_INFO[skopeMode] || MODE_INFO['motivation'];
  const displayName = skopeMode === 'custom' ? `Custom: ${skopeCustomTag}` : modeObj.name;

  if (!videos || videos.length === 0) {
    skopeFeed.innerHTML = `
      <div class="skope-feed-header">
        <h2 class="skope-feed-title">${displayName}</h2>
        <div class="skope-mode-badge">
          <span>${modeObj.emoji}</span>
          <span>${modeObj.name}</span>
        </div>
      </div>
      <div style="text-align: center; padding: 60px 20px; color: var(--yt-spec-text-secondary, #606060);">
        <p style="font-size: 16px; font-weight: 500;">No videos loaded for this focus.</p>
        <p style="font-size: 13px; margin-top: 8px;">Try clicking "Refresh Feed" in Skope popup or check your API keys.</p>
      </div>
    `;
    return;
  }

  // Shuffle and cache full pool locally for pagination
  allVideos = [...videos].sort(() => Math.random() - 0.5);
  renderedVideos = [];

  skopeFeed.innerHTML = `
    <div class="skope-feed-header">
      <h2 class="skope-feed-title">${displayName}</h2>
      <div class="skope-mode-badge">
        <span>${modeObj.emoji}</span>
        <span>${modeObj.name}</span>
      </div>
    </div>
    <div class="skope-grid" id="skope-grid-container">
      <!-- Appended dynamically via infinite scroll -->
    </div>
  `;

  // Render first batch of 12 videos
  renderMoreVideos(12);
}

// Appends next batch of videos to grid
function renderMoreVideos(count) {
  const gridContainer = document.getElementById('skope-grid-container');
  if (!gridContainer) return;

  const currentCount = renderedVideos.length;
  if (currentCount >= allVideos.length) return; // All loaded

  const nextBatch = allVideos.slice(currentCount, currentCount + count);
  let cardsHtml = '';

  nextBatch.forEach(video => {
    renderedVideos.push(video);
    const channelInitial = video.channelTitle ? video.channelTitle.charAt(0) : 'S';
    cardsHtml += `
      <a class="skope-card" href="${video.videoUrl}">
        <div class="skope-thumbnail-container">
          <img class="skope-thumbnail" src="${video.thumbnail}" alt="${video.title}" loading="lazy">
          <span class="skope-duration">${video.durationFormatted}</span>
        </div>
        <div class="skope-details-container">
          <div class="skope-avatar-placeholder">${channelInitial}</div>
          <div class="skope-meta">
            <h3 class="skope-title" title="${video.title}">${video.title}</h3>
            <span class="skope-channel" title="${video.channelTitle}">${video.channelTitle}</span>
            <span class="skope-stats">${video.viewsFormatted} • ${video.relativeTime}</span>
          </div>
        </div>
      </a>
    `;
  });

  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = cardsHtml;
  while (tempDiv.firstChild) {
    gridContainer.appendChild(tempDiv.firstChild);
  }
}

// Window scroll listener for infinite scroll
function handleScroll() {
  if (!skopeEnabled) return;

  const url = window.location.href;
  const isHome = url === 'https://www.youtube.com/' || url.startsWith('https://www.youtube.com/?') || window.location.pathname === '/';
  if (!isHome) return;

  const scrollHeight = document.documentElement.scrollHeight;
  const scrollTop = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop;
  const clientHeight = document.documentElement.clientHeight;

  // Trigger reload if we are within 400px of the bottom
  if (scrollHeight - scrollTop - clientHeight < 400) {
    renderMoreVideos(12);
  }
}

// Render Watch page sidebar
function renderWatchpageSidebar(videos) {
  const skopeSidebar = document.getElementById('skope-sidebar');
  if (!skopeSidebar) return;

  const modeObj = MODE_INFO[skopeMode] || MODE_INFO['motivation'];
  const displayName = skopeMode === 'custom' ? skopeCustomTag : modeObj.name;

  if (!videos || videos.length === 0) {
    skopeSidebar.innerHTML = `
      <h3 class="skope-sidebar-title">Focused: ${displayName}</h3>
      <div style="padding: 20px; text-align: center; color: var(--yt-spec-text-secondary, #606060); font-size: 13px;">
        No focus videos available.
      </div>
    `;
    return;
  }

  // 1. Get current video title to align recommendations contextually
  const currentTitle = document.querySelector('h1.ytd-watch-metadata')?.textContent || document.title || '';
  
  // 2. Extract significant keywords
  const stopWords = new Set(['the', 'a', 'of', 'and', 'to', 'in', 'is', 'for', 'on', 'with', 'at', 'by', 'an', 'this', 'that', 'from', 'how', 'what', 'why', 'official', 'video', 'music', 'lyrics', 'full', 'hd', '2024', '2025', '2026']);
  const keywords = currentTitle.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));

  // 3. Score candidate videos based on matching title or channel keywords
  const scoredVideos = videos.map(video => {
    let score = 0;
    const titleLower = video.title.toLowerCase();
    const channelLower = video.channelTitle.toLowerCase();

    keywords.forEach(keyword => {
      if (titleLower.includes(keyword)) score += 10;
      if (channelLower.includes(keyword)) score += 5;
    });

    return { video, score };
  });

  // 4. Sort primarily by relevance, secondarily randomizing to introduce fresh recommendations
  scoredVideos.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    // Random shuffle for equal score nodes to keep recommendations dynamic
    return Math.random() - 0.5;
  });

  const sortedVideos = scoredVideos.map(item => item.video);

  let listHtml = '';
  // Show up to 12 items in the sidebar
  sortedVideos.slice(0, 12).forEach(video => {
    listHtml += `
      <a class="skope-sidebar-item" href="${video.videoUrl}">
        <div class="skope-sidebar-thumb-container">
          <img class="skope-thumbnail" src="${video.thumbnail}" alt="${video.title}" loading="lazy">
          <span class="skope-duration">${video.durationFormatted}</span>
        </div>
        <div class="skope-sidebar-meta">
          <h4 class="skope-sidebar-title-text" title="${video.title}">${video.title}</h4>
          <span class="skope-sidebar-channel" title="${video.channelTitle}">${video.channelTitle}</span>
          <span class="skope-sidebar-stats">${video.viewsFormatted} • ${video.relativeTime}</span>
        </div>
      </a>
    `;
  });

  skopeSidebar.innerHTML = `
    <h3 class="skope-sidebar-title">Focused recommendations (${displayName})</h3>
    <div class="skope-sidebar-list">
      ${listHtml}
    </div>
  `;
}

// Skeleton loaders
function renderSkeletonFeed() {
  const skopeFeed = document.getElementById('skope-feed');
  if (!skopeFeed) return;

  let skeletons = '';
  for (let i = 0; i < 12; i++) {
    skeletons += `
      <div class="skope-card skope-skeleton">
        <div class="skope-thumbnail-container"></div>
        <div class="skope-details-container">
          <div class="skope-avatar-placeholder"></div>
          <div class="skope-meta">
            <div class="skope-skeleton-text title-1"></div>
            <div class="skope-skeleton-text title-2"></div>
            <div class="skope-skeleton-text channel"></div>
            <div class="skope-skeleton-text stats"></div>
          </div>
        </div>
      </div>
    `;
  }

  skopeFeed.innerHTML = `
    <div class="skope-feed-header">
      <h2 class="skope-feed-title">Loading focus...</h2>
    </div>
    <div class="skope-grid">
      ${skeletons}
    </div>
  `;
}

function renderSkeletonSidebar() {
  const skopeSidebar = document.getElementById('skope-sidebar');
  if (!skopeSidebar) return;

  let skeletons = '';
  for (let i = 0; i < 6; i++) {
    skeletons += `
      <div class="skope-sidebar-item skope-sidebar-skeleton">
        <div class="skope-sidebar-thumb-container"></div>
        <div class="skope-sidebar-meta">
          <div class="skope-sidebar-skeleton-text title-1"></div>
          <div class="skope-sidebar-skeleton-text title-2"></div>
          <div class="skope-sidebar-skeleton-text channel"></div>
          <div class="skope-sidebar-skeleton-text stats"></div>
        </div>
      </div>
    `;
  }

  skopeSidebar.innerHTML = `
    <h3 class="skope-sidebar-title">Loading recommendations...</h3>
    <div class="skope-sidebar-list">
      ${skeletons}
    </div>
  `;
}

// Clean up and restore YouTube elements
function removeSkopeElements() {
  // Remove injected elements
  const feed = document.getElementById('skope-feed');
  if (feed) feed.remove();

  const sidebar = document.getElementById('skope-sidebar');
  if (sidebar) sidebar.remove();

  // Show native elements
  const nativeFeed = document.querySelector('ytd-rich-grid-renderer');
  if (nativeFeed) {
    nativeFeed.classList.remove('skope-hidden');
  }

  const nativeSecondary = document.querySelector('#secondary ytd-watch-next-secondary-results-renderer');
  if (nativeSecondary) {
    nativeSecondary.classList.remove('skope-hidden');
  }
}

// Element references
const powerToggle = document.getElementById('power-toggle');
const statusText = document.getElementById('status-text');
const modeCards = document.querySelectorAll('.mode-card');
const customTagInput = document.getElementById('custom-tag-input');
const applyCustomBtn = document.getElementById('apply-custom-btn');
const saveTagBtn = document.getElementById('save-tag-btn');
const savedTagsContainer = document.getElementById('saved-tags-container');
const savedTagsList = document.getElementById('saved-tags-list');
const recentTagsContainer = document.getElementById('recent-tags-container');
const recentTagsList = document.getElementById('recent-tags-list');
const refreshBtn = document.getElementById('refresh-btn');
const statusIndicator = document.getElementById('status-indicator');
const tagline = document.querySelector('.tagline');

const MODE_INFO = {
  motivation: { name: 'Motivation' },
  study: { name: 'Study' },
  music: { name: 'Music' },
  ai: { name: 'AI' }
};

let savedTags = [];
let recentTags = [];


// Load stored settings on open
chrome.storage.local.get(['skopeEnabled', 'skopeMode', 'skopeCustomTag', 'skopeSavedTags', 'skopeRecentTags'], (settings) => {
  const isEnabled = settings.skopeEnabled !== false;
  const activeMode = settings.skopeMode || 'motivation';
  const customTag = settings.skopeCustomTag || '';
  savedTags = settings.skopeSavedTags || [];
  recentTags = settings.skopeRecentTags || [];

  // 1. Initialize power toggle
  powerToggle.checked = isEnabled;
  updatePowerUI(isEnabled);

  // 2. Initialize custom tag input
  customTagInput.value = customTag;

  // 3. Initialize mode cards and stats
  updateActiveModeUI(activeMode, customTag);

  // 4. Render tags lists
  renderSavedTags();
  renderRecentTags();
});

// Event listener: Power toggle change
powerToggle.addEventListener('change', () => {
  const isEnabled = powerToggle.checked;
  updatePowerUI(isEnabled);
  
  chrome.storage.local.set({ skopeEnabled: isEnabled }, () => {
    // Notify background script of state change
    chrome.runtime.sendMessage({ action: 'STATE_CHANGED' });
    showStatus(isEnabled ? 'Skope is ON' : 'Skope is OFF');
  });
});

// Event listener: Preset mode cards
modeCards.forEach(card => {
  card.addEventListener('click', () => {
    if (!powerToggle.checked) return;

    const mode = card.dataset.mode;
    
    // Update storage
    chrome.storage.local.set({ skopeMode: mode }, () => {
      updateActiveModeUI(mode);
      showStatus(`Switched to ${card.querySelector('.mode-name').textContent}`);
      
      // Notify background
      chrome.runtime.sendMessage({ action: 'STATE_CHANGED' });
    });
  });
});

// Helper: Apply a custom focus tag via backend state change
function applyCustomFocus(tag) {
  showStatus('Expanding tag via Gemini...');
  applyCustomBtn.disabled = true;
  if (saveTagBtn) saveTagBtn.disabled = true;

  chrome.storage.local.set({
    skopeMode: 'custom',
    skopeCustomTag: tag
  }, () => {
    updateActiveModeUI('custom', tag);
    
    // Notify background
    chrome.runtime.sendMessage({ action: 'STATE_CHANGED' }, (response) => {
      applyCustomBtn.disabled = false;
      if (saveTagBtn) saveTagBtn.disabled = false;
      if (response && response.error) {
        showStatus('Gemini API Error');
      } else {
        showStatus('Custom feed applied!');
      }
    });
  });
}

// Helper: Apply a custom focus tag via backend state change
function applyCustomFocus(tag) {
  showStatus('Expanding tag via Gemini...');
  applyCustomBtn.disabled = true;
  if (saveTagBtn) saveTagBtn.disabled = true;

  chrome.storage.local.set({
    skopeMode: 'custom',
    skopeCustomTag: tag
  }, () => {
    updateActiveModeUI('custom', tag);
    addRecentTag(tag);
    
    // Notify background
    chrome.runtime.sendMessage({ action: 'STATE_CHANGED' }, (response) => {
      applyCustomBtn.disabled = false;
      if (saveTagBtn) saveTagBtn.disabled = false;
      if (response && response.error) {
        showStatus('Gemini API Error');
      } else {
        showStatus('Custom feed applied!');
      }
    });
  });
}

// Helper: Add tag to recents and save
function addRecentTag(tag) {
  if (!tag || !tag.trim()) return;
  const trimmed = tag.trim();
  recentTags = recentTags.filter(t => t.toLowerCase() !== trimmed.toLowerCase());
  recentTags.unshift(trimmed);
  recentTags = recentTags.slice(0, 3);
  chrome.storage.local.set({ skopeRecentTags: recentTags }, () => {
    renderRecentTags();
  });
}

// Helper: Render the list of recently used tags
function renderRecentTags() {
  recentTagsList.innerHTML = '';
  
  if (recentTags.length === 0) {
    recentTagsContainer.style.display = 'none';
    return;
  }
  
  recentTagsContainer.style.display = 'flex';
  
  recentTags.forEach(tag => {
    const pill = document.createElement('div');
    pill.className = 'recent-tag-pill';
    pill.textContent = tag;
    
    pill.addEventListener('click', () => {
      if (!powerToggle.checked) return;
      customTagInput.value = tag;
      applyCustomFocus(tag);
    });
    
    recentTagsList.appendChild(pill);
  });
}

// Event listener: Apply custom focus tag
applyCustomBtn.addEventListener('click', () => {
  if (!powerToggle.checked) return;

  const tag = customTagInput.value.trim();
  if (!tag) {
    showStatus('Please enter a tag');
    customTagInput.focus();
    return;
  }

  applyCustomFocus(tag);
});

// Event listener: Save custom focus tag
saveTagBtn.addEventListener('click', () => {
  if (!powerToggle.checked) return;

  const tag = customTagInput.value.trim();
  if (!tag) {
    showStatus('Please enter a tag to save');
    customTagInput.focus();
    return;
  }

  if (savedTags.includes(tag)) {
    showStatus('Tag already saved');
    return;
  }

  savedTags.push(tag);
  chrome.storage.local.set({ skopeSavedTags: savedTags }, () => {
    renderSavedTags();
    showStatus('Tag saved!');
  });
});

// Helper: Render the list of saved tags
function renderSavedTags() {
  savedTagsList.innerHTML = '';
  
  if (savedTags.length === 0) {
    savedTagsContainer.style.display = 'none';
    return;
  }
  
  savedTagsContainer.style.display = 'flex';
  
  savedTags.forEach(tag => {
    const pill = document.createElement('div');
    pill.className = 'saved-tag-pill';
    
    const label = document.createElement('span');
    label.textContent = tag;
    
    const deleteBtn = document.createElement('span');
    deleteBtn.className = 'delete-tag-btn';
    deleteBtn.innerHTML = '&times;';
    deleteBtn.title = 'Delete';
    
    pill.addEventListener('click', (e) => {
      if (e.target === deleteBtn) {
        // Delete clicked
        savedTags = savedTags.filter(t => t !== tag);
        chrome.storage.local.set({ skopeSavedTags: savedTags }, () => {
          renderSavedTags();
          showStatus('Tag removed');
        });
      } else {
        // Apply tag clicked
        if (!powerToggle.checked) return;
        customTagInput.value = tag;
        applyCustomFocus(tag);
      }
    });
    
    pill.appendChild(label);
    pill.appendChild(deleteBtn);
    savedTagsList.appendChild(pill);
  });
}

// Event listener: Refresh feed button
refreshBtn.addEventListener('click', () => {
  if (!powerToggle.checked) return;

  refreshBtn.classList.add('refresh-spinning');
  showStatus('Refreshing feed...');

  chrome.runtime.sendMessage({ action: 'REFRESH_FEED' }, (response) => {
    refreshBtn.classList.remove('refresh-spinning');
    if (response && response.error) {
      showStatus('Refresh failed');
      console.error(response.error);
    } else {
      showStatus('Feed updated!');
      // Re-fetch storage to update stats immediately
      chrome.storage.local.get(['skopeMode', 'skopeCustomTag'], (settings) => {
        updateStats(settings.skopeMode || 'motivation', settings.skopeCustomTag || '');
      });
    }
  });
});

// Helper: Update toggle UI state
function updatePowerUI(isEnabled) {
  statusText.textContent = isEnabled ? 'ON' : 'OFF';
  if (isEnabled) {
    document.body.classList.remove('disabled-mode');
  } else {
    document.body.classList.add('disabled-mode');
  }
}

// Helper: Update stats in footer
function updateStats(mode, customTag) {
  if (isShowingStatus) return; // Don't overwrite active status notifications
  
  let cacheKey = '';
  if (mode === 'custom') {
    const sanitizedTag = (customTag || '').trim().toLowerCase();
    cacheKey = `skope_cache_custom_${encodeURIComponent(sanitizedTag)}`;
  } else {
    cacheKey = `skope_cache_preset_${mode}`;
  }

  chrome.storage.local.get(cacheKey, (data) => {
    if (isShowingStatus) return; // Double check in case status changed during async load
    
    if (data && data[cacheKey]) {
      const { videos, timestamp } = data[cacheKey];
      const count = videos ? videos.length : 0;
      const elapsedMs = Date.now() - timestamp;
      const mins = Math.round(elapsedMs / 60000);
      
      let timeStr = 'just now';
      if (mins >= 60) {
        const hours = Math.round(mins / 60);
        timeStr = `${hours}h ago`;
      } else if (mins > 0) {
        timeStr = `${mins}m ago`;
      }
      
      statusIndicator.textContent = `${count} videos • cached ${timeStr}`;
    } else {
      statusIndicator.textContent = 'No cached videos';
    }
  });
}

// Helper: Highlight active mode in UI
function updateActiveModeUI(mode, customTag = '') {
  // Clear all active classes
  modeCards.forEach(card => {
    card.classList.remove('active');
    card.classList.remove('active-custom');
  });

  // Update dynamic tagline mode indicator at the top
  if (mode === 'custom') {
    tagline.textContent = `Focus: ${customTag}`;
  } else {
    const modeObj = MODE_INFO[mode] || MODE_INFO['motivation'];
    tagline.textContent = `${modeObj.name} Mode`;
  }

  if (mode === 'custom') {
    showStatus(`Custom: ${customTag || 'Applied'}`);
  } else {
    // Find matching preset card
    const targetCard = document.querySelector(`.mode-card[data-mode="${mode}"]`);
    if (targetCard) {
      targetCard.classList.add('active');
      showStatus(`Active: ${targetCard.querySelector('.mode-name').textContent}`);
    }
  }

  // Update footer statistics based on current active cache
  updateStats(mode, customTag);
}

// Helper: Show brief status message
let statusTimeout;
let isShowingStatus = false;
function showStatus(text) {
  isShowingStatus = true;
  clearTimeout(statusTimeout);
  statusIndicator.textContent = text;
  
  // Revert status back to stats after 3 seconds
  statusTimeout = setTimeout(() => {
    isShowingStatus = false;
    chrome.storage.local.get(['skopeMode', 'skopeCustomTag'], (settings) => {
      updateStats(settings.skopeMode || 'motivation', settings.skopeCustomTag || '');
    });
  }, 3000);
}

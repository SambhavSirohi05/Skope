// Element references
const powerToggle = document.getElementById('power-toggle');
const statusText = document.getElementById('status-text');
const modeCards = document.querySelectorAll('.mode-card');
const customTagInput = document.getElementById('custom-tag-input');
const applyCustomBtn = document.getElementById('apply-custom-btn');
const refreshBtn = document.getElementById('refresh-btn');
const statusIndicator = document.getElementById('status-indicator');

// Load stored settings on open
chrome.storage.local.get(['skopeEnabled', 'skopeMode', 'skopeCustomTag'], (settings) => {
  const isEnabled = settings.skopeEnabled !== false;
  const activeMode = settings.skopeMode || 'motivation';
  const customTag = settings.skopeCustomTag || '';

  // 1. Initialize power toggle
  powerToggle.checked = isEnabled;
  updatePowerUI(isEnabled);

  // 2. Initialize custom tag input
  customTagInput.value = customTag;

  // 3. Initialize mode cards
  updateActiveModeUI(activeMode, customTag);
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

// Event listener: Apply custom focus tag
applyCustomBtn.addEventListener('click', () => {
  if (!powerToggle.checked) return;

  const tag = customTagInput.value.trim();
  if (!tag) {
    showStatus('Please enter a tag');
    customTagInput.focus();
    return;
  }

  showStatus('Expanding tag via Gemini...');
  applyCustomBtn.disabled = true;

  chrome.storage.local.set({
    skopeMode: 'custom',
    skopeCustomTag: tag
  }, () => {
    updateActiveModeUI('custom', tag);
    
    // Notify background
    chrome.runtime.sendMessage({ action: 'STATE_CHANGED' }, (response) => {
      applyCustomBtn.disabled = false;
      if (response && response.error) {
        showStatus('Gemini API Error');
      } else {
        showStatus('Custom feed applied!');
      }
    });
  });
});

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

// Helper: Highlight active mode in UI
function updateActiveModeUI(mode, customTag = '') {
  // Clear all active classes
  modeCards.forEach(card => {
    card.classList.remove('active');
    card.classList.remove('active-custom');
  });

  if (mode === 'custom') {
    // If custom mode is active but none of the cards are custom,
    // we can style the custom tag input container or active state
    showStatus(`Custom: ${customTag || 'Applied'}`);
  } else {
    // Find matching preset card
    const targetCard = document.querySelector(`.mode-card[data-mode="${mode}"]`);
    if (targetCard) {
      targetCard.classList.add('active');
      showStatus(`Active: ${targetCard.querySelector('.mode-name').textContent}`);
    }
  }
}

// Helper: Show brief status message
let statusTimeout;
function showStatus(text) {
  clearTimeout(statusTimeout);
  statusIndicator.textContent = text;
  
  // Fade status back to 'Ready' after 3 seconds
  statusTimeout = setTimeout(() => {
    statusIndicator.textContent = 'Ready';
  }, 3000);
}

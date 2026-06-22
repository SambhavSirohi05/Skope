let config = null;

/**
 * Loads and parses the local .env file in the extension context.
 * 
 * @returns {Promise<{GEMINI_API_KEY: string, YOUTUBE_API_KEY: string}>}
 */
export async function getConfig() {
  if (config) return config;

  try {
    const url = chrome.runtime.getURL('.env');
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch .env with status ${response.status}`);
    }
    const text = await response.text();
    const env = {};
    
    text.split('\n').forEach(line => {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('#')) return; // Skip empty and comments

      const parts = trimmedLine.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        let val = parts.slice(1).join('=').trim();
        // Strip quotes if present
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
        env[key] = val;
      }
    });

    config = {
      GEMINI_API_KEY: env.GEMINI_API_KEY || '',
      YOUTUBE_API_KEY: env.YOUTUBE_API_KEY || ''
    };
    return config;
  } catch (err) {
    console.error('Failed to load local config .env file:', err);
    return { GEMINI_API_KEY: '', YOUTUBE_API_KEY: '' };
  }
}

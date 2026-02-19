// Service worker for Page Summarizer (Manifest V3)
// All API calls are made directly from popup.js — this file satisfies
// the MV3 service_worker requirement and handles lifecycle events.

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    console.log('Page Summarizer installed. Click the extension icon on any webpage to summarize it.');
  }
});

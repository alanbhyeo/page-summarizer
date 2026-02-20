'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL   = 'claude-haiku-4-5';
const MAX_CHARS      = 50_000; // ~12 500 tokens — well within the 200K context window

// ─── DOM References ───────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const settingsBtn    = $('settingsBtn');
const settingsPanel  = $('settingsPanel');
const apiKeyInput    = $('apiKeyInput');
const saveKeyBtn     = $('saveKeyBtn');
const openSettingsBtn = $('openSettingsBtn');
const summarizeBtn   = $('summarizeBtn');
const retryBtn       = $('retryBtn');
const refreshBtn     = $('refreshBtn');
const copyBtn        = $('copyBtn');
const bulletList     = $('bulletList');
const errorMsg       = $('errorMsg');
const pageTitle      = $('pageTitle');

// ─── State Management ─────────────────────────────────────────────────────────

const STATE_IDS = ['noKey', 'ready', 'loading', 'result', 'error'];

function showState(name) {
  STATE_IDS.forEach(id => {
    $(`${id}State`).classList.toggle('hidden', id !== name);
  });
}

// ─── Initialize ───────────────────────────────────────────────────────────────

async function init() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (apiKey) {
    apiKeyInput.value = apiKey;
    showState('ready');
  } else {
    showState('noKey');
  }
}

// ─── Settings Panel ───────────────────────────────────────────────────────────

settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
  if (!settingsPanel.classList.contains('hidden')) {
    apiKeyInput.focus();
  }
});

openSettingsBtn.addEventListener('click', () => {
  settingsPanel.classList.remove('hidden');
  apiKeyInput.focus();
});

saveKeyBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  await chrome.storage.local.set({ apiKey: key });
  settingsPanel.classList.add('hidden');
  showState('ready');
});

apiKeyInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') saveKeyBtn.click();
});

// ─── Copy to Clipboard ────────────────────────────────────────────────────────

copyBtn.addEventListener('click', async () => {
  const text = Array.from(bulletList.querySelectorAll('li'))
    .map(li => `• ${li.textContent}`)
    .join('\n');

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for environments where clipboard API is restricted
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }

  copyBtn.textContent = '✓ Copied!';
  copyBtn.classList.add('copied');
  setTimeout(() => {
    copyBtn.textContent = 'Copy to Clipboard';
    copyBtn.classList.remove('copied');
  }, 2000);
});

// ─── Summarize ────────────────────────────────────────────────────────────────

summarizeBtn.addEventListener('click', summarize);
retryBtn.addEventListener('click', summarize);
refreshBtn.addEventListener('click', summarize);

async function summarize() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    settingsPanel.classList.remove('hidden');
    apiKeyInput.focus();
    return;
  }

  showState('loading');

  try {
    // Get active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Could not find the active tab.');

    // Block browser-internal pages where scripting is not allowed
    const url = tab.url || '';
    if (
      url.startsWith('chrome://') ||
      url.startsWith('chrome-extension://') ||
      url.startsWith('edge://') ||
      url.startsWith('about:') ||
      url === ''
    ) {
      throw new Error(
        'This page cannot be summarized. Navigate to a regular website and try again.'
      );
    }

    // Inject content extractor into the active tab
    let pageText;
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractPageContent,
      });
      pageText = result?.result ?? '';
    } catch {
      throw new Error(
        'Cannot access this page. It may be protected or require a page refresh.'
      );
    }

    if (!pageText || pageText.trim().length < 100) {
      throw new Error(
        'Not enough readable text found on this page. Try a different page.'
      );
    }

    // Truncate if needed to stay within a reasonable token budget
    const content = pageText.length > MAX_CHARS
      ? pageText.slice(0, MAX_CHARS) + '\n[Content truncated]'
      : pageText;

    // Call Claude API
    const bullets = await callClaude(content, tab.title || 'Untitled Page');

    // Render results
    pageTitle.textContent = tab.title || '';
    bulletList.innerHTML = '';
    bullets.forEach(text => {
      const li = document.createElement('li');
      li.textContent = text;
      bulletList.appendChild(li);
    });

    showState('result');
  } catch (err) {
    errorMsg.textContent = err.message || 'An unexpected error occurred. Please try again.';
    showState('error');
  }
}

// ─── Claude API Call ──────────────────────────────────────────────────────────

async function callClaude(content, title) {
  const { apiKey } = await chrome.storage.local.get('apiKey');

  const prompt =
    `Summarize the following webpage in exactly 5 bullet points. ` +
    `Each point must be a single short sentence of 10 words or fewer. ` +
    `Be direct and cut all unnecessary words. ` +
    `Return exactly 5 lines of plain text — one point per line — with no ` +
    `bullet symbols, numbers, dashes, or extra formatting. Just the text.\n\n` +
    `Page: "${title}"\n\n` +
    `Content:\n${content}`;

  let response;
  try {
    response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch {
    throw new Error('Network error. Check your internet connection and try again.');
  }

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    const apiMsg = errBody?.error?.message;

    // Log the full error for debugging — open popup DevTools to see this
    console.error('[Page Summarizer] API error', response.status,
      errBody?.error?.type, '—', errBody?.error?.message);

    if (response.status === 401) {
      throw new Error('Invalid API key. Please update your key in settings.');
    }
    if (response.status === 429) {
      throw new Error('Rate limit reached. Wait a moment, then try again.');
    }
    if (response.status >= 500) {
      throw new Error('The Claude API is temporarily unavailable. Please try again shortly.');
    }
    throw new Error(apiMsg || `API error (${response.status}). Please try again.`);
  }

  const data = await response.json();
  const raw = data?.content?.[0]?.text?.trim() ?? '';

  // Parse and clean up lines — strip any stray bullets/numbers the model might add
  const lines = raw
    .split('\n')
    .map(l => l.trim().replace(/^[\d]+[.)]\s*/, '').replace(/^[•\-\*▸]\s*/, ''))
    .filter(l => l.length > 0)
    .slice(0, 5);

  if (lines.length === 0) {
    throw new Error('Could not generate a summary. Please try again.');
  }

  return lines;
}

// ─── Content Extractor (injected into page) ───────────────────────────────────
//
// This function runs inside the target tab's context — it must be self-contained
// with no references to variables defined in popup.js.

function extractPageContent() {
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT',
    'EMBED', 'NAV', 'FOOTER', 'ASIDE',
  ]);

  function getText(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (SKIP_TAGS.has(node.tagName)) return '';
    if (node.hidden) return '';
    if (node.getAttribute('aria-hidden') === 'true') return '';
    if (node.getAttribute('role') === 'banner') return '';
    if (node.getAttribute('role') === 'navigation') return '';

    return Array.from(node.childNodes).map(getText).join(' ');
  }

  // Prefer semantic content containers when present
  const candidates = [
    'article',
    'main',
    '[role="main"]',
    '.post-content',
    '.entry-content',
    '.article-content',
    '.article-body',
    '.story-body',
    '#content',
    '.content',
  ];

  let root = null;
  for (const sel of candidates) {
    root = document.querySelector(sel);
    if (root) break;
  }
  if (!root) root = document.body;

  return getText(root)
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

init();

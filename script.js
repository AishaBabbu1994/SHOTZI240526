/* ============================================================
   Explícame — script.js
   Chatbot powered by Groq API (Llama 3.3 70B)
   ============================================================ */

// ── STATE ────────────────────────────────────────────────────
const state = {
  groqApiKey: null,
  awaitingToken: false,
  isStreaming: false,
  history: [],          // { role, content }[]
  config: null,
};

// ── DOM REFS ─────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const messagesEl    = $('messages');
const inputEl       = $('input');
const sendBtn       = $('send-btn');
const statusDot     = $('status-dot');
const suggestionsEl = $('suggestions');
const welcomeEl     = $('welcome');
const btnReset      = $('btn-reset');

// ── INIT ─────────────────────────────────────────────────────
async function init() {
  try {
    const res = await fetch('config.json');
    state.config = await res.json();
  } catch {
    state.config = getFallbackConfig();
  }

  // Restore API key from session storage (not localStorage for privacy)
  const savedKey = sessionStorage.getItem('groq_api_key');
  if (savedKey) {
    state.groqApiKey = savedKey;
    setStatus(true);
    renderSuggestions();
    addBotMessage(
      '¡De vuelta! Tu API Key sigue activa. ¿Qué te explico hoy?',
      false
    );
  } else {
    askForToken();
  }

  setupInputHandlers();
  setupResetButton();
}

// ── CONFIG FALLBACK ───────────────────────────────────────────
function getFallbackConfig() {
  return {
    bot: {
      name: 'Shotzi',
      avatar: '✦',
      welcomeMessage: '¡Hola! Necesito tu **API Key de Groq** para funcionar.\n\nObtén una gratis en [console.groq.com](https://console.groq.com) y pégala aquí:',
      tokenSuccess: '¡Perfecto! API Key guardada. ¿Qué quieres que te explique? 🚀',
      tokenError: 'Esa API Key no parece válida. Debe empezar con `gsk_`. Inténtalo de nuevo.',
      systemPrompt: 'Eres Shotzi, un asistente que explica cualquier concepto de forma clara, simple y directa. Eres conversacional, curioso y nunca condescendiente. Respondes en el mismo idioma del usuario.',
    },
    groq: {
      apiUrl: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.3-70b-versatile',
      maxTokens: 1024,
      temperature: 0.7,
      stream: true,
    },
    ui: {
      placeholderMessages: [
        '¿Qué es la inflación?',
        'Explícame cómo funciona el WiFi',
        '¿Por qué el cielo es azul?',
      ],
    },
  };
}

// ── TOKEN FLOW ────────────────────────────────────────────────
function askForToken() {
  state.awaitingToken = true;
  state.groqApiKey = null;
  setStatus(false);
  clearSuggestions();

  const welcomeMsg = state.config.bot.welcomeMessage ||
    '¡Hola! Escribe tu API Key de Groq para comenzar:';
  addBotMessage(welcomeMsg, true);
  inputEl.placeholder = 'Pega tu API Key de Groq aquí…';
  inputEl.type = 'password';
}

async function handleTokenSubmit(rawKey) {
  const key = rawKey.trim();

  if (!key.startsWith('gsk_') || key.length < 30) {
    addUserMessage('••••••••••••••');
    addBotMessage(state.config.bot.tokenError, true);
    return;
  }

  // Validate with a lightweight request
  addUserMessage('••••••••••••••');
  const thinking = addThinking();

  const valid = await validateApiKey(key);
  removeEl(thinking);

  if (!valid) {
    addBotMessage(state.config.bot.tokenError, true);
    return;
  }

  state.groqApiKey = key;
  state.awaitingToken = false;
  sessionStorage.setItem('groq_api_key', key);
  setStatus(true);
  inputEl.placeholder = 'Pregúntame algo…';
  inputEl.type = 'text';
  renderSuggestions();

  addBotMessage(state.config.bot.tokenSuccess, false);
}

async function validateApiKey(key) {
  try {
    const res = await fetch(state.config.groq.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: state.config.groq.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5,
        stream: false,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── SEND MESSAGE ──────────────────────────────────────────────
async function sendMessage(text) {
  if (state.awaitingToken) {
    await handleTokenSubmit(text);
    return;
  }

  if (!text.trim() || state.isStreaming) return;

  showMessages();
  clearSuggestions();

  addUserMessage(text);
  state.history.push({ role: 'user', content: text });

  const thinking = addThinking();
  state.isStreaming = true;
  updateSendBtn();

  try {
    const reply = await streamGroqResponse(thinking);
    state.history.push({ role: 'assistant', content: reply });
  } catch (err) {
    removeEl(thinking);
    addBotMessage(`⚠️ Error: ${err.message || 'No se pudo conectar con Groq. Verifica tu API Key.'}`, false);
  } finally {
    state.isStreaming = false;
    updateSendBtn();
  }
}

async function streamGroqResponse(thinkingEl) {
  const cfg = state.config.groq;
  const messages = [
    { role: 'system', content: state.config.bot.systemPrompt },
    ...state.history,
  ];

  const res = await fetch(cfg.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.groqApiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      max_tokens: cfg.maxTokens,
      temperature: cfg.temperature,
      stream: true,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || `HTTP ${res.status}`;

    // If 401 → key likely revoked
    if (res.status === 401) {
      sessionStorage.removeItem('groq_api_key');
      state.groqApiKey = null;
      state.awaitingToken = false;
      removeEl(thinkingEl);
      addBotMessage('Tu API Key ya no es válida o fue revocada. Por favor, ingresa una nueva:', true);
      askForToken();
      return '';
    }
    throw new Error(msg);
  }

  // Replace thinking bubble with streaming bubble
  const botMsg = createBotBubble();
  thinkingEl.replaceWith(botMsg.wrapper);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') break;

      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          botMsg.bubble.innerHTML = renderMarkdown(fullText);
          scrollToBottom();
        }
      } catch { /* ignore parse errors */ }
    }
  }

  return fullText;
}

// ── MARKDOWN RENDERER ─────────────────────────────────────────
function renderMarkdown(text) {
  let html = escapeHtml(text);

  // Bold **text**
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // Italic *text* or _text_
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.*?)_/g, '<em>$1</em>');
  // Inline code `code`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Links [text](url)
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );
  // Unordered lists
  html = html.replace(/^[•\-\*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>(\n|$))+/g, '<ul>$&</ul>');
  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  // Line breaks → paragraphs
  const paragraphs = html.split(/\n\n+/);
  html = paragraphs
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => (p.startsWith('<ul>') || p.startsWith('<li>') ? p : `<p>${p}</p>`))
    .join('');
  // Single line breaks inside paragraphs
  html = html.replace(/<p>([\s\S]*?)<\/p>/g, (_, inner) => {
    return `<p>${inner.replace(/\n/g, '<br>')}</p>`;
  });

  return html;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── DOM HELPERS ───────────────────────────────────────────────
function showMessages() {
  if (welcomeEl.style.display !== 'none') {
    welcomeEl.style.display = 'none';
    messagesEl.style.display = 'flex';
  }
}

function addUserMessage(text) {
  showMessages();
  const wrapper = document.createElement('div');
  wrapper.className = 'msg user';
  wrapper.innerHTML = `
    <div class="avatar">tú</div>
    <div class="bubble">${escapeHtml(text)}</div>
  `;
  messagesEl.appendChild(wrapper);
  scrollToBottom();
}

function addBotMessage(text, isTokenPrompt = false) {
  showMessages();
  const wrapper = document.createElement('div');
  wrapper.className = 'msg bot';

  const avatarLabel = state.config?.bot?.avatar || '✦';
  const extraClass = isTokenPrompt ? ' token-prompt' : '';

  wrapper.innerHTML = `
    <div class="avatar">${avatarLabel}</div>
    <div class="bubble${extraClass}">${renderMarkdown(text)}</div>
  `;
  messagesEl.appendChild(wrapper);
  scrollToBottom();
  return wrapper;
}

function addThinking() {
  showMessages();
  const wrapper = document.createElement('div');
  wrapper.className = 'msg bot thinking';
  const avatarLabel = state.config?.bot?.avatar || '✦';
  wrapper.innerHTML = `
    <div class="avatar">${avatarLabel}</div>
    <div class="bubble">
      <div class="dot"></div>
      <div class="dot"></div>
      <div class="dot"></div>
    </div>
  `;
  messagesEl.appendChild(wrapper);
  scrollToBottom();
  return wrapper;
}

function createBotBubble() {
  const wrapper = document.createElement('div');
  wrapper.className = 'msg bot';
  const avatarLabel = state.config?.bot?.avatar || '✦';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  wrapper.innerHTML = `<div class="avatar">${avatarLabel}</div>`;
  wrapper.appendChild(bubble);
  messagesEl.appendChild(wrapper);
  scrollToBottom();
  return { wrapper, bubble };
}

function removeEl(el) {
  el?.parentNode?.removeChild(el);
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setStatus(active) {
  statusDot.classList.toggle('active', active);
}

function updateSendBtn() {
  sendBtn.disabled = state.isStreaming;
}

// ── SUGGESTIONS ───────────────────────────────────────────────
function renderSuggestions() {
  const items = state.config?.ui?.placeholderMessages || [];
  clearSuggestions();
  items.forEach(text => {
    const chip = document.createElement('button');
    chip.className = 'suggestion-chip';
    chip.textContent = text;
    chip.addEventListener('click', () => {
      inputEl.value = text;
      handleSend();
    });
    suggestionsEl.appendChild(chip);
  });
}

function clearSuggestions() {
  suggestionsEl.innerHTML = '';
}

// ── INPUT HANDLERS ────────────────────────────────────────────
function setupInputHandlers() {
  // Auto-grow textarea
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
  });

  // Send on Enter (Shift+Enter = newline)
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  sendBtn.addEventListener('click', handleSend);
}

function handleSend() {
  const text = inputEl.value.trim();
  if (!text || state.isStreaming) return;
  inputEl.value = '';
  inputEl.style.height = 'auto';
  sendMessage(text);
}

// ── RESET ─────────────────────────────────────────────────────
function setupResetButton() {
  btnReset.addEventListener('click', () => {
    state.history = [];
    state.groqApiKey = null;
    state.awaitingToken = false;
    state.isStreaming = false;
    sessionStorage.removeItem('groq_api_key');

    messagesEl.innerHTML = '';
    messagesEl.style.display = 'none';
    welcomeEl.style.display = '';
    clearSuggestions();

    inputEl.value = '';
    inputEl.type = 'text';
    inputEl.placeholder = 'Pregúntame algo…';
    setStatus(false);
    updateSendBtn();

    askForToken();
  });
}

// ── START ─────────────────────────────────────────────────────
init();

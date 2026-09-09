/* global acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();

  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const planBadge = document.getElementById('planBadge');

  let streamingEl = null;

  function planLabel(p) {
    if (!p || !p.plan) return '–';
    return p.planName || p.plan;
  }
  function planClass(p) {
    return p && p.plan ? p.plan : '';
  }

  function addMessage(cls, text) {
    if (streamingEl && cls === 'assistant' && text !== '__new__') {
      return streamingEl;
    }
    const el = document.createElement('div');
    el.className = 'msg ' + cls;
    if (text && text !== '__new__') {
      el.textContent = text;
    }
    messages.appendChild(el);
    scrollBottom();
    return el;
  }

  function scrollBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  function appendStream(text) {
    if (!streamingEl) {
      streamingEl = addMessage('assistant', '__new__');
    }
    streamingEl.textContent = (streamingEl.textContent || '') + text;
    scrollBottom();
  }

  function addToolBadge(name) {
    const badge = document.createElement('span');
    badge.className = 'tool-badge';
    badge.textContent = '⚙ ' + name;
    messages.appendChild(badge);
    scrollBottom();
  }

  function showLogin() {
    planBadge.textContent = 'not logged in';
    planBadge.className = 'plan-badge';
    const el = document.createElement('div');
    el.className = 'msg system login-card';
    el.innerHTML =
      '<div>Connect your Meldrix account to unlock your plan &amp; tools.</div>' +
      '<button id="loginBtn">Login</button>';
    messages.appendChild(el);
    document.getElementById('loginBtn').onclick = () =>
      vscode.postMessage({ type: 'login' });
    scrollBottom();
  }

  function sendMessage() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    addMessage('user', text);
    vscode.postMessage({ type: 'chat', text });
  }

  send.addEventListener('click', sendMessage);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'plan':
        planBadge.textContent = planLabel(msg.plan);
        planBadge.className = 'plan-badge ' + planClass(msg.plan);
        break;
      case 'status':
        streamingEl = null;
        addMessage('system', msg.text);
        break;
      case 'token':
        appendStream(msg.text);
        break;
      case 'tool':
        addToolBadge(msg.name);
        break;
      case 'done':
        streamingEl = null;
        break;
      case 'error':
        streamingEl = null;
        addMessage('error', msg.text);
        break;
      case 'loggedOut':
        planBadge.textContent = 'not logged in';
        planBadge.className = 'plan-badge';
        break;
    }
  });

  // Request initial state on load.
  vscode.postMessage({ type: 'ready' });
})();
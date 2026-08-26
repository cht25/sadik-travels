/*
 * Sadik Travels — shared real-time chat client (storefront + admin console).
 *
 * Firebase Realtime Database is the real-time source of truth: when the server
 * reports `realtime: "firebase"` this client signs into Firebase Auth with a
 * server-minted custom token and attaches Realtime Database listeners
 * (onValue / onChildAdded / onChildChanged / onChildRemoved). Messages are
 * written straight to the database, so every other participant receives them
 * instantly — no polling, no refresh.
 *
 * When Firebase is not configured (local development), the same API is served
 * by the Socket.IO hub, which pushes events — also never polling.
 *
 * Nothing here trusts the client for authorization: conversation creation and
 * every REST fallback go through the server, and the Realtime Database rules
 * (database.rules.json) only let participants read/write their own nodes.
 */
(() => {
  const STORAGE_KEY = 'sadik_chat_identity_v2';
  const TYPING_TTL_MS = 6000;
  const TYPING_THROTTLE_MS = 2000;

  const state = {
    readyPromise: null,
    viewer: null,
    realtime: 'socket',
    firebase: null,
    firebaseApp: null,
    identityCredentials: loadCredentials(),
    listeners: new Set(),
    conversationWatchers: new Map(),
    inboxWatcher: null,
    typingSentAt: new Map(),
    typingClearTimers: new Map(),
    connectionState: 'connecting',
    connectionListeners: new Set()
  };

  function loadCredentials() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
  }
  function saveCredentials(credentials) {
    state.identityCredentials = credentials || null;
    try {
      if (credentials) localStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* storage may be unavailable (private mode) */ }
  }

  const api = window.SadikApi || {
    request: async (path, options = {}) => {
      const response = await fetch(`/api/v1${path}`, { credentials: 'include', ...options, headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(payload?.error?.message || `Request failed (${response.status})`), { code: payload?.error?.code, status: response.status });
      return payload;
    }
  };

  const identityHeader = () => (state.identityCredentials ? { 'x-chat-identity': `${state.identityCredentials.uid}.${state.identityCredentials.secret}` } : {});

  function setConnectionState(value) {
    if (state.connectionState === value) return;
    state.connectionState = value;
    state.connectionListeners.forEach(listener => { try { listener(value); } catch { /* listener errors must not break the client */ } });
  }
  function onConnectionState(listener) {
    state.connectionListeners.add(listener);
    listener(state.connectionState);
    return () => state.connectionListeners.delete(listener);
  }

  /* ------------------------- bootstrap ------------------------- */

  async function bootstrap() {
    let payload;
    try {
      payload = await api.request('/chat/session', { method: 'POST', body: JSON.stringify({}), headers: identityHeader() });
    } catch (error) {
      if (state.identityCredentials && (error?.status === 401 || error?.status === 403)) {
        // Stored guest credentials are no longer valid (cleared database, new deployment):
        // discard them and mint a fresh guest identity.
        saveCredentials(null);
        payload = await api.request('/chat/session', { method: 'POST', body: JSON.stringify({}) });
      } else throw error;
    }
    state.viewer = { ...payload.identity, supportStaff: !!payload.supportStaff, vendor: !!payload.vendor };
    state.realtime = payload.realtime || 'socket';
    if (payload.credentials) saveCredentials(payload.credentials);
    if (state.realtime === 'firebase' && payload.firebase) {
      state.firebase = payload.firebase;
      await ensureFirebaseSignIn();
    } else {
      ensureSocket();
    }
    return viewerInfo();
  }

  function ready() {
    if (!state.readyPromise) {
      state.readyPromise = bootstrap().catch(error => {
        state.readyPromise = null;
        throw error;
      });
    }
    return state.readyPromise;
  }

  /** Re-run bootstrap (fresh custom token) — used after auth/permission errors. */
  async function reauthenticate() {
    state.readyPromise = null;
    return ready();
  }

  function viewerInfo() {
    return { ...state.viewer, realtime: state.realtime, supportStaff: !!state.viewer?.supportStaff, vendor: !!state.viewer?.vendor };
  }

  async function refreshIdentity() {
    const payload = await api.request('/chat/session', { method: 'POST', body: JSON.stringify({}), headers: identityHeader() });
    state.viewer = { ...payload.identity, supportStaff: !!payload.supportStaff, vendor: !!payload.vendor };
    if (payload.credentials) saveCredentials(payload.credentials);
    return viewerInfo();
  }

  /** Enrich the guest profile from the intro form (server validates + stores). */
  async function updateProfile(profile) {
    const payload = await api.request('/chat/session', { method: 'POST', body: JSON.stringify(profile || {}), headers: identityHeader() });
    state.viewer = { ...payload.identity, supportStaff: !!payload.supportStaff, vendor: !!payload.vendor };
    if (payload.credentials) saveCredentials(payload.credentials);
    if (state.realtime === 'firebase' && payload.firebase) {
      state.firebase = payload.firebase;
      await ensureFirebaseSignIn();
    }
    return viewerInfo();
  }

  /* ------------------------- Firebase transport ------------------------- */

  let firebaseSdkPromise = null;
  function loadFirebaseSdk() {
    if (firebaseSdkPromise) return firebaseSdkPromise;
    firebaseSdkPromise = new Promise((resolve, reject) => {
      if (window.firebase?.database) { resolve(window.firebase); return; }
      const scripts = [
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js',
        'https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js'
      ];
      let loaded = 0;
      let failed = false;
      const next = () => {
        loaded += 1;
        if (loaded === scripts.length && !failed) resolve(window.firebase);
      };
      scripts.forEach(src => {
        const tag = document.createElement('script');
        tag.src = src;
        tag.async = true;
        tag.onerror = () => { if (!failed) { failed = true; reject(Object.assign(new Error('Realtime chat libraries failed to load'), { code: 'FIREBASE_SDK_MISSING' })); } };
        tag.onload = next;
        document.head.appendChild(tag);
      });
    });
    return firebaseSdkPromise;
  }

  async function ensureFirebaseSignIn() {
    const firebase = await loadFirebaseSdk();
    if (!state.firebaseApp) state.firebaseApp = firebase.apps.length ? firebase.apps[0] : firebase.initializeApp(state.firebase.config);
    const auth = firebase.auth(state.firebaseApp);
    if (!auth.currentUser) await auth.signInWithCustomToken(state.firebase.authToken);
    const database = firebase.database(state.firebaseApp);
    database.ref('.info/connected').on('value', snapshot => setConnectionState(snapshot.val() === true ? 'online' : 'offline'));
    attachPresence(database);
    return database;
  }

  function attachPresence(database) {
    const uid = state.viewer?.uid;
    if (!uid) return;
    const presenceRef = database.ref(`presence/${uid}`);
    presenceRef.onDisconnect().set({ online: false, lastSeen: Date.now() });
    presenceRef.set({ online: true, lastSeen: Date.now() });
  }

  function ref(path) {
    const firebase = window.firebase;
    return firebase.database(state.firebaseApp).ref(path);
  }

  function watchInboxFirebase(onChange) {
    const conversations = new Map();
    const childWatchers = new Map();
    const emit = () => {
      const list = [...conversations.values()].sort((a, b) => (b.lastMessage?.sentAt || b.updatedAt || 0) - (a.lastMessage?.sentAt || a.updatedAt || 0));
      onChange(list);
    };
    const stopConversationWatcher = id => {
      const stop = childWatchers.get(id);
      if (stop) { stop(); childWatchers.delete(id); }
      conversations.delete(id);
    };
    const watchConversationMeta = id => {
      if (childWatchers.has(id)) return;
      const handler = snapshot => {
        const value = snapshot.val();
        if (!value) { stopConversationWatcher(id); emit(); return; }
        conversations.set(id, { id, ...value });
        emit();
      };
      const off = ref(`conversations/${id}`).on('value', handler, error => console.warn('chat inbox watcher', error?.message));
      childWatchers.set(id, () => ref(`conversations/${id}`).off('value', handler));
    };
    const stops = [];
    if (state.viewer?.supportStaff) {
      // Support staff can read the whole conversations node (rules mirror the
      // server-side support.view permission): one listener drives the inbox.
      const handler = snapshot => {
        const value = snapshot.val() || {};
        const seen = new Set(Object.keys(value));
        Object.keys(value).forEach(id => conversations.set(id, { id, ...value[id] }));
        [...conversations.keys()].forEach(id => { if (!seen.has(id)) conversations.delete(id); });
        emit();
      };
      const off = ref('conversations').on('value', handler, error => console.warn('chat inbox watcher', error?.message));
      stops.push(() => ref('conversations').off('value', handler));
    } else {
      const indexHandler = snapshot => {
        const ids = Object.keys(snapshot.val() || {});
        ids.forEach(watchConversationMeta);
        [...conversations.keys()].forEach(id => { if (!ids.includes(id)) stopConversationWatcher(id); });
        emit();
      };
      const indexOff = ref(`userConversations/${state.viewer.uid}`).on('value', indexHandler, error => console.warn('chat inbox watcher', error?.message));
      stops.push(() => ref(`userConversations/${state.viewer.uid}`).off('value', indexHandler));
    }
    return () => {
      stops.forEach(stop => stop());
      [...childWatchers.values()].forEach(stop => stop());
      childWatchers.clear();
      conversations.clear();
    };
  }

  function watchConversationFirebase(conversationId, handlers) {
    const cleanups = [];
    let initialMessagesDone = false;
    const messageHandler = snapshot => {
      const value = snapshot.val();
      if (!value || !initialMessagesDone) return;
      handlers.onMessage?.({ id: snapshot.key, conversationId, ...value });
    };
    // Mark the transcript snapshot complete before attaching child listeners
    // so the initial history is delivered exactly once (via onValue below).
    const historyHandler = snapshot => {
      const value = snapshot.val() || {};
      const messages = Object.keys(value).map(key => ({ id: key, conversationId, ...value[key] }))
        .sort((a, b) => (a.sentAt || 0) - (b.sentAt || 0) || String(a.id).localeCompare(String(b.id)));
      initialMessagesDone = true;
      handlers.onHistory?.(messages);
    };
    const messagesRef = ref(`messages/${conversationId}`);
    messagesRef.on('child_added', messageHandler, error => console.warn('chat message watcher', error?.message));
    cleanups.push(() => messagesRef.off('child_added', messageHandler));

    const presenceWatchers = new Map();
    const watchPresenceFor = uid => {
      if (presenceWatchers.has(uid)) return;
      const handler = snapshot => handlers.onPresence?.({ uid, ...(snapshot.val() || {}) });
      ref(`presence/${uid}`).on('value', handler);
      presenceWatchers.set(uid, () => ref(`presence/${uid}`).off('value', handler));
    };
    // Single listener: conversation metadata, presence subscriptions for the
    // other participants, and (below) the initial transcript.
    const conversationHandler = snapshot => {
      const value = snapshot.val();
      if (!value) return;
      handlers.onConversation?.({ id: conversationId, ...value });
      Object.keys(value.participants || {}).forEach(uid => { if (uid !== state.viewer?.uid) watchPresenceFor(uid); });
    };
    ref(`conversations/${conversationId}`).on('value', conversationHandler, error => console.warn('chat conversation watcher', error?.message));
    cleanups.push(() => ref(`conversations/${conversationId}`).off('value', conversationHandler));
    ref(`conversations/${conversationId}`).once('value').then(conversationHandler).catch(() => undefined);

    // Initial history first, then live child events (child_added re-deliveries are deduped by id in the UI).
    messagesRef.once('value').then(historyHandler).catch(() => handlers.onHistory?.([]));

    const typingHandler = snapshot => {
      const value = snapshot.val() || {};
      const entries = Object.keys(value)
        .filter(uid => uid !== state.viewer?.uid)
        .map(uid => ({ uid, at: Number(value[uid]) || 0 }))
        .filter(entry => Date.now() - entry.at < TYPING_TTL_MS);
      handlers.onTyping?.(entries);
    };
    ref(`typing/${conversationId}`).on('value', typingHandler);
    cleanups.push(() => ref(`typing/${conversationId}`).off('value', typingHandler));

    return () => {
      cleanups.forEach(cleanup => { try { cleanup(); } catch { /* ignore */ } });
      [...presenceWatchers.values()].forEach(cleanup => cleanup());
    };
  }

  async function sendViaFirebase(conversationId, text, conversation) {
    const sentAtOffset = window.firebase.database.ServerValue.TIMESTAMP;
    const messageRef = ref(`messages/${conversationId}`).push();
    const id = messageRef.key;
    const message = { id, conversationId, senderId: state.viewer.uid, senderRole: senderRoleHint(), text, type: 'text', sentAt: sentAtOffset };
    await messageRef.set(message);
    const updates = {
      [`conversations/${conversationId}/lastMessage`]: { text, senderId: state.viewer.uid, senderRole: senderRoleHint(), sentAt: Date.now() },
      [`conversations/${conversationId}/updatedAt`]: Date.now()
    };
    await ref('/').update(updates).catch(() => undefined);
    const others = Object.keys(conversation?.participants || {}).filter(uid => uid !== state.viewer.uid && uid !== 'support-team');
    await Promise.all(others.map(uid => ref(`conversations/${conversationId}/unread/${uid}`).transaction(current => Number(current || 0) + 1).catch(() => undefined)));
    return { id, conversationId, senderId: state.viewer.uid, senderRole: senderRoleHint(), text, type: 'text', sentAt: Date.now(), pending: false };
  }

  function senderRoleHint() {
    const role = state.viewer?.role;
    if (['hotel_owner', 'home_owner', 'travel_agent', 'support', 'super_admin', 'admin', 'manager', 'staff'].includes(role)) {
      return ['hotel_owner', 'home_owner', 'travel_agent'].includes(role) ? role : 'support';
    }
    return 'customer';
  }

  async function markReadFirebase(conversationId) {
    const updates = {};
    updates[`conversations/${conversationId}/reads/${state.viewer.uid}`] = Date.now();
    updates[`conversations/${conversationId}/unread/${state.viewer.uid}`] = 0;
    await ref('/').update(updates);
  }

  async function setTypingFirebase(conversationId, typing) {
    const path = `typing/${conversationId}/${state.viewer.uid}`;
    if (typing) {
      const last = state.typingSentAt.get(conversationId) || 0;
      if (Date.now() - last < TYPING_THROTTLE_MS) return;
      state.typingSentAt.set(conversationId, Date.now());
      const typingRef = ref(path);
      await typingRef.onDisconnect().remove().catch(() => undefined);
      await typingRef.set(Date.now());
      clearTimeout(state.typingClearTimers.get(conversationId));
      state.typingClearTimers.set(conversationId, setTimeout(() => { ref(path).remove().catch(() => undefined); }, TYPING_TTL_MS));
    } else {
      state.typingSentAt.delete(conversationId);
      clearTimeout(state.typingClearTimers.get(conversationId));
      await ref(path).remove().catch(() => undefined);
    }
  }

  /* ------------------------- Socket.IO transport (fallback) ------------------------- */

  let socket = null;
  const socketInboxListeners = new Set();
  const socketConversationWatchers = new Map();

  function ensureSocket() {
    if (socket || !window.io) {
      if (socket) setConnectionState(socket.connected ? 'online' : 'offline');
      return socket;
    }
    socket = window.io({ path: '/socket.io', transports: ['websocket', 'polling'], reconnectionDelayMax: 5000, auth: { identity: state.identityCredentials ? `${state.identityCredentials.uid}.${state.identityCredentials.secret}` : undefined } });
    socket.on('connect', () => {
      setConnectionState('online');
      socket.emit('chat:hello', {}, result => {
        if (result?.ok) {
          state.viewer = { ...state.viewer, ...result.viewer, uid: result.viewer.uid };
          (result.conversations || []).forEach(conversation => socketEmitConversation(conversation));
        }
      });
    });
    socket.on('disconnect', () => setConnectionState('offline'));
    socket.on('chat:conversation', payload => socketEmitConversation(payload?.conversation));
    socket.on('connect_error', () => setConnectionState('offline'));
    return socket;
  }

  function socketEmitConversation(conversation) {
    if (!conversation?.id) return;
    const entry = socketConversationWatchers.get(conversation.id);
    if (entry?.handlers.onConversation) entry.handlers.onConversation(conversation);
    socketInboxListeners.forEach(listener => { try { listener(conversation); } catch { /* ignore */ } });
  }

  function watchInboxSocket(onChange) {
    const conversations = new Map();
    socketInboxListeners.add(conversation => {
      conversations.set(conversation.id, conversation);
      const list = [...conversations.values()].sort((a, b) => (b.lastMessage?.sentAt || b.updatedAt || 0) - (a.lastMessage?.sentAt || a.updatedAt || 0));
      onChange(list);
    });
    ensureSocket();
    api.request('/chat/conversations', { headers: identityHeader() }).then(payload => {
      (payload.conversations || []).forEach(conversation => conversations.set(conversation.id, conversation));
      onChange([...conversations.values()].sort((a, b) => (b.lastMessage?.sentAt || b.updatedAt || 0) - (a.lastMessage?.sentAt || a.updatedAt || 0)));
    }).catch(() => onChange([]));
    return () => socketInboxListeners.delete(onChange);
  }

  function watchConversationSocket(conversationId, handlers) {
    const socketRef = ensureSocket();
    if (!socketRef) { handlers.onError?.({ code: 'SOCKET_UNAVAILABLE', message: 'Real-time chat is unavailable right now.' }); return () => undefined; }
    socketConversationWatchers.set(conversationId, { handlers });
    const onMessage = payload => { if (payload?.message?.conversationId === conversationId) handlers.onMessage?.(payload.message); };
    const onRead = payload => { if (payload?.conversationId === conversationId) handlers.onRead?.(payload); };
    const onTyping = payload => { if (payload?.conversationId === conversationId) handlers.onTyping?.([{ uid: payload.uid, name: payload.name, at: Date.now() }]); };
    const onPresence = payload => handlers.onPresence?.(payload);
    socketRef.on('chat:message', onMessage);
    socketRef.on('chat:read', onRead);
    socketRef.on('chat:typing', onTyping);
    socketRef.on('chat:presence', onPresence);
    socketRef.emit('chat:join', { conversationId }, result => {
      if (result?.ok) {
        handlers.onConversation?.(result.conversation);
        handlers.onHistory?.(result.messages || []);
      } else {
        handlers.onError?.(result?.error);
      }
    });
    return () => {
      socketConversationWatchers.delete(conversationId);
      socketRef.off('chat:message', onMessage);
      socketRef.off('chat:read', onRead);
      socketRef.off('chat:typing', onTyping);
      socketRef.off('chat:presence', onPresence);
    };
  }

  function sendViaSocket(conversationId, text) {
    return new Promise((resolve, reject) => {
      const socketRef = ensureSocket();
      const timeout = setTimeout(() => reject(new Error('Sending the message timed out')), 10000);
      socketRef.emit('chat:send', { conversationId, text }, result => {
        clearTimeout(timeout);
        if (result?.ok) resolve(result.message);
        else reject(Object.assign(new Error(result?.error?.message || 'Unable to send the message'), { code: result?.error?.code }));
      });
    });
  }

  /* ------------------------- public API ------------------------- */

  async function openConversation(type, contextId) {
    await ready();
    const payload = await api.request('/chat/conversations', { method: 'POST', body: JSON.stringify({ type, ...(contextId ? { contextId } : {}) }), headers: identityHeader() });
    return payload.conversation;
  }

  async function openExisting(conversationId) {
    await ready();
    return api.request(`/chat/conversations/${encodeURIComponent(conversationId)}`, { headers: identityHeader() });
  }

  async function sendMessage(conversationId, text, conversation) {
    await ready();
    const clean = String(text || '').trim();
    if (!clean) throw new Error('Type a message first');
    if (state.realtime === 'firebase') {
      try {
        return await sendViaFirebase(conversationId, clean, conversation);
      } catch (error) {
        console.warn('Direct realtime write failed; falling back to the REST send path.', error?.message);
      }
    }
    return sendViaSocket(conversationId, clean);
  }

  function markRead(conversationId) {
    if (state.realtime === 'firebase') {
      return markReadFirebase(conversationId).catch(error => console.warn('markRead failed', error?.message));
    }
    ensureSocket()?.emit('chat:read', { conversationId }, () => undefined);
    return Promise.resolve();
  }

  function setTyping(conversationId, typing) {
    if (state.realtime === 'firebase') {
      return setTypingFirebase(conversationId, typing).catch(() => undefined);
    }
    ensureSocket()?.emit('chat:typing', { conversationId, typing: !!typing }, () => undefined);
    return Promise.resolve();
  }

  function watchInbox(onChange) {
    if (state.realtime === 'firebase') return watchInboxFirebase(onChange);
    return watchInboxSocket(onChange);
  }

  function watchConversation(conversationId, handlers) {
    if (state.realtime === 'firebase') return watchConversationFirebase(conversationId, handlers);
    return watchConversationSocket(conversationId, handlers);
  }

  window.SadikChat = {
    ready,
    refreshIdentity,
    updateProfile,
    reauthenticate,
    openConversation,
    openExisting,
    sendMessage,
    markRead,
    setTyping,
    watchInbox,
    watchConversation,
    onConnectionState,
    get viewer() { return state.viewer ? { ...state.viewer } : null; },
    get transport() { return state.realtime; },
    get connectionState() { return state.connectionState; }
  };
})();

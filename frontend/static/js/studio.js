// ─── TranStream Studio recorder component (Phases 2 + 3 + 4 + 5 + 5.5 + 7 + UI overhaul) ──
//
// Mic path (unchanged, proven green since 63fd646):
//   Browser mic → MediaRecorder 100 ms slices → WebSocket binary frames
//   → Django Channels AudioConsumer → incremental temp file → raw recording
//   → FFmpeg normalization → 16 kHz mono PCM WAV
//   → Silero VAD segments → Faster-Whisper transcript
//   + live rolling preview ("live_transcript_update") while recording.
//
// Upload path (Phase 7, fully independent, now routed through Media Gallery):
//   Media Gallery → XHR POST /studio/upload/ → 202 {job_id} → poll
//   /studio/jobs/<id>/ → /studio/jobs/<id>/transcript/ → render in tab.
//
// UI overhaul (current goal):
//   • Media Gallery left sidebar: collapsible + resizable, two root folders
//     (Uploaded Audio / Recorded Audio), configurable paths via settings,
//     rename folders/files, click-to-load existing transcription (no re-run).
//   • Single mic toggle button (icon + label) replaces Start/Stop.
//   • Transcription window: fixed to viewport, scrollable, resizable from left.
//   • Multiple transcription tabs: click a file in Media Gallery → opens a tab.
//   • Upload panel removed; uploads live in Media Gallery.
//
// Isolation rule: the upload path reads ONLY pure formatters and writes ONLY
// into `this.upload.*` / tab state. It never touches transcriptSegments,
// vadSegments, saved, normalized, liveTranscriptText or any WS/mic flag.
//
// Ordering guarantee (Phase 2, unchanged): every slice is pushed through a
// serialized promise queue so binary frames reach the server in capture order;
// the JSON "stop" control is sent only after the queue drains.

document.addEventListener('alpine:init', () => {

  // ════════════════════════════════════════════════════════════════════════════
  // Shared store: Media Gallery state (roots, settings, rename)
  // ════════════════════════════════════════════════════════════════════════════

  Alpine.store('tsGallery', {
    roots: [],
    showSettings: false,
    renameItem: null,   // {type:'folder'|'file', id, parentId, name, newName}

    init() {
      const stored = localStorage.getItem('ts_media_roots_v1');
      if (stored) {
        try { this.roots = JSON.parse(stored); } catch (e) { this.roots = defaultRoots(); }
      } else {
        this.roots = defaultRoots();
      }
    },

    save() {
      localStorage.setItem('ts_media_roots_v1', JSON.stringify(this.roots));
    },

    // ── folder tree helpers ──
    findNode(id) {
      for (const root of this.roots) {
        const found = this._findInChildren(root.children, id);
        if (found) return found;
      }
      return null;
    },

    _findInChildren(children, id) {
      for (const c of children || []) {
        if (c.id === id) return c;
        if (c.children) {
          const deep = this._findInChildren(c.children, id);
          if (deep) return deep;
        }
      }
      return null;
    },

    findParent(id) {
      for (const root of this.roots) {
        const parent = this._findParentInChildren(root.children, id, root);
        if (parent) return parent;
      }
      return null;
    },

    _findParentInChildren(children, id, parent) {
      for (const c of children || []) {
        if (c.id === id) return parent;
        if (c.children) {
          const deep = this._findParentInChildren(c.children, id, c);
          if (deep) return deep;
        }
      }
      return null;
    },

    addRoot() {
      this.roots.push({
        id: 'root-' + Date.now(),
        name: 'New Folder',
        path: '',
        expanded: true,
        children: [],
      });
      this.save();
    },

    removeRoot(root) {
      this.roots = this.roots.filter(r => r.id !== root.id);
      this.save();
    },

    createFolder(parent) {
      if (!parent.children) parent.children = [];
      parent.children.push({
        id: 'folder-' + Date.now(),
        name: 'New Folder',
        path: '',
        expanded: true,
        children: [],
      });
      parent.expanded = true;
      this.save();
    },

    addFileToNode(parent, file) {
      if (!parent.children) parent.children = [];
      parent.children.push({
        id: 'file-' + Date.now(),
        name: file.name,
        type: 'file',
        takeId: file.takeId || null,
        size: file.size || 0,
        mime: file.type || 'audio/mpeg',
        durationMs: file.durationMs || 0,
        hasTranscript: !!file.takeId,
        path: parent.path || '',
        uploadedAt: new Date().toISOString(),
      });
      parent.expanded = true;
      this.save();
    },

    startRename(item) {
      this.renameItem = {
        type: item.type || 'folder',
        id: item.id,
        parentId: item.parentId || null,
        name: item.name,
        newName: item.name,
      };
    },

    confirmRename() {
      if (!this.renameItem) return;
      const { id, type, newName } = this.renameItem;
      const node = type === 'folder' ? this.findNode(id) : this.findNode(id);
      if (node) node.name = newName.trim() || node.name;
      this.renameItem = null;
      this.save();
    },

    cancelRename() {
      this.renameItem = null;
    },

    deleteNode(id) {
      // find and remove from parent's children
      for (const root of this.roots) {
        if (this._removeFromChildren(root.children, id)) { this.save(); return; }
      }
    },

    _removeFromChildren(children, id) {
      const idx = children.findIndex(c => c.id === id);
      if (idx >= 0) { children.splice(idx, 1); return true; }
      for (const c of children || []) {
        if (c.children && this._removeFromChildren(c.children, id)) return true;
      }
      return false;
    },
  });

  function defaultRoots() {
    return [
      { id: 'root-uploaded', name: 'Uploaded Audio', path: '', expanded: true, children: [] },
      { id: 'root-recorded', name: 'Recorded Audio', path: '', expanded: true, children: [] },
    ];
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Media Gallery component (left sidebar)
  // ════════════════════════════════════════════════════════════════════════════

  Alpine.data('mediaGallery', () => ({
    isCollapsed: false,
    resizeStartX: 0,
    resizeStartWidth: 0,
    uploadTargetId: null,   // root/folder id receiving the next upload

    init() {
      // nothing to do; store is self-initialising
    },

    get roots() { return Alpine.store('tsGallery').roots; },
    get showSettings() { return Alpine.store('tsGallery').showSettings; },
    set showSettings(v) { Alpine.store('tsGallery').showSettings = v; },
    get renameItem() { return Alpine.store('tsGallery').renameItem; },

    // ── collapse / resize ──
    toggleCollapse() {
      this.isCollapsed = !this.isCollapsed;
    },

    startResize(e) {
      this.resizeStartX = e.clientX;
      this.resizeStartWidth = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width') || '320');
      document.documentElement.style.setProperty('--sidebar-resizing', '1');
      window.addEventListener('mousemove', this.onResize);
      window.addEventListener('mouseup', this.stopResize);
    },

    onResize(e) {
      const dx = e.clientX - this.resizeStartX;
      let w = this.resizeStartWidth + dx;
      w = Math.max(200, Math.min(600, w));
      document.documentElement.style.setProperty('--sidebar-width', w + 'px');
    },

    stopResize() {
      document.documentElement.style.removeProperty('--sidebar-resizing');
      window.removeEventListener('mousemove', this.onResize);
      window.removeEventListener('mouseup', this.stopResize);
    },

    // ── settings ──
    openSettings() { this.showSettings = true; },
    closeSettings() { this.showSettings = false; },

    saveSettings() {
      this.showSettings = false;
      Alpine.store('tsGallery').save();
    },

    addRoot() {
      Alpine.store('tsGallery').addRoot();
    },

    removeRoot(root) {
      Alpine.store('tsGallery').removeRoot(root);
    },

    createFolder(parent) {
      Alpine.store('tsGallery').createFolder(parent);
    },

    // ── upload into a folder ──
    setUploadTarget(node) {
      this.uploadTargetId = node.id;
      const input = document.getElementById('ts-mg-upload-input');
      if (input) input.click();
    },

    async onMgFileChosen(e) {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      const node = this._findNodeById(this.uploadTargetId);
      if (!node) return;
      for (const f of files) {
        await this.uploadFileToNode(f, node);
      }
      e.target.value = '';
      this.uploadTargetId = null;
    },

    async uploadFileToNode(file, node) {
      const u = this.$parent.upload;  // studioRecorder's upload namespace
      u.file = file;
      u.name = file.name || 'upload';
      u.size = file.size || 0;
      u.uploading = false; u.progress = 0;
      u.jobId = null; u.takeId = null;
      u.state = ''; u.pct = 0; u.error = null; u.code = '';
      u.segments = []; u.language = ''; u.languageProbability = 0; u.durationMs = 0;
      u.translationTarget = 'en'; u.translationText = ''; u.translationSource = '';
      u.translationLoading = false; u.translationError = '';

      // Route through Media Gallery root folder path context
      u._mgTargetNode = node;
      await this.$parent.startUpload();
    },

    // ── file actions ──
    startRename(item) {
      Alpine.store('tsGallery').startRename(item);
    },
    confirmRename() {
      Alpine.store('tsGallery').confirmRename();
    },
    cancelRename() {
      Alpine.store('tsGallery').cancelRename();
    },
    deleteNode(id) {
      Alpine.store('tsGallery').deleteNode(id);
    },

    // ── click on audio file → open transcription tab ──
    async openFile(fileNode) {
      const studio = this.$parent;
      // If it already has a take id, open existing transcription directly.
      if (fileNode.takeId) {
        studio.openExistingTab(fileNode.takeId, fileNode.name);
        return;
      }
      // Otherwise, trigger the file picker for this node.
      this.setUploadTarget(fileNode);
    },

    _findNodeById(id) {
      const store = Alpine.store('tsGallery');
      for (const root of store.roots) {
        if (root.id === id) return root;
        const found = store._findInChildren(root.children, id);
        if (found) return found;
      }
      return null;
    },

    // ── recursive folder tree HTML renderer ──
    renderFolderTree(node) {
      const store = Alpine.store('tsGallery');
      let html = '';
      for (const c of node.children || []) {
        const isFolder = c.type === 'folder';
        const hasChildren = c.children && c.children.length > 0;
        const childrenHtml = hasChildren && c.expanded
          ? '<div class="ml-4">' + this.renderFolderTree(c) + '</div>'
          : '';
        html += `
          <div class="flex items-center gap-2 px-2 py-1.5 hover:bg-white/5 rounded-lg cursor-pointer transition">
            <button
              @click.stop="c.expanded = !c.expanded"
              class="flex-shrink-0 w-4 h-4 flex items-center justify-center text-slate-400 hover:text-white"
              ${!isFolder ? 'style="display:none"' : ''}
            >
              <svg class="w-3 h-3 transition-transform" :class="c.expanded ? 'rotate-90' : ''" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>
              </svg>
            </button>
            <span class="flex-1 text-sm text-slate-200 truncate cursor-pointer hover:text-cyan-300 ${isFolder ? 'font-medium' : ''}" @dblclick.stop="startRename(c)" title="${c.name}">${c.name}</span>
            ${isFolder && hasChildren && !c.expanded
              ? '<span class="text-[10px] text-slate-500 ml-auto">+' + c.children.length + '</span>'
              : ''
            }
            <div class="flex items-center gap-1">
              ${isFolder
                ? '<button @click.stop="createFolder(c)" class="p-1 rounded text-slate-400 hover:text-white" title="New folder"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg></button>'
                : ''
              }
              <button @click.stop="setUploadTarget(c)" class="p-1 rounded text-slate-400 hover:text-white" title="Upload audio"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg></button>
              <button @click.stop="startRename(c)" class="p-1 rounded text-slate-400 hover:text-cyan-300" title="Rename"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.414l8.586-8.586z"></path></svg></button>
              <button @click.stop="deleteNode(c.id)" class="p-1 rounded text-rose-400 hover:text-rose-300" title="Delete"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg></button>
            </div>
          </div>
          ${childrenHtml}
        `;
      }
      return html;
    },

    getFileIcon(node) {
      if (node.type === 'file') {
        const m = (node.mime || '').toLowerCase();
        if (m.includes('wav')) return '🎵';
        if (m.includes('mp3')) return '🎧';
        if (m.includes('m4a') || m.includes('aac')) return '🎶';
        if (m.includes('flac')) return '🎼';
        if (m.includes('ogg') || m.includes('webm')) return '📼';
        return '📄';
      }
      return '📁';
    },

    getFileSizeText(bytes) {
      if (!bytes) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      let i = 0, v = Number(bytes);
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
      return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
    },
  }));

  // ════════════════════════════════════════════════════════════════════════════
  // Studio Recorder component (main area)
  // ════════════════════════════════════════════════════════════════════════════

  Alpine.data('studioRecorder', () => ({
    // ── public state ──
    recording: false,
    connecting: false,
    error: null,
    saved: null,
    sessionId: '',
    nativeScript: false,
    takeId: '',
    normalizing: false,
    normalized: null,
    normalizeMessage: '',

    // ── Phase 4: VAD ──
    vadRunning: false,
    vadSegments: [],
    vadTotalSpeechMs: 0,
    vadMessage: '',

    // ── Phase 5: transcription ──
    transcribing: false,
    transcribeMessage: '',
    languageDetected: '',
    languageProbability: 0,
    transcriptSegments: [],

    // ── Phase 5.5: live rolling preview ──
    liveTranscriptText: '',
    liveSegmentCount: 0,
    liveLanguage: '',
    liveActive: false,
    activeTab: 'transcribe',

    // ── Phase 9/10: mic translation + TTS ──
    micTranslationTarget: 'en',
    micTranslationLoading: false,
    micTranslationError: '',
    micTranslationText: '',
    micTranslationSource: '',
    ttsPlaying: false,
    micTranslationExpanded: false,

    // ── Advanced transcription display state ──
    transcriptView: 'subtitle',   // 'subtitle' | 'timestamp' | 'compact'
    showTimestamps: true,
    activeSpeaker: '',

    // ── Multi-tab state ──
    tabs: [],
    activeTabId: null,

    // ── counters ─
    chunksSent: 0,
    chunksReceived: 0,
    bytesReceived: 0,
    serverDurationMs: 0,
    elapsedMs: 0,
    maxBytes: 0,

    // ── internals ──
    _ws: null,
    _recorder: null,
    _stream: null,
    _sendQueue: Promise.resolve(),
    _timer: null,
    _startTs: 0,
    _mime: '',
    _micSpeakers: null,

    // ── Phase 7: file upload (own namespace; see isolation rule above) ──
    upload: {
      file: null, name: '', size: 0, dragOver: false,
      uploading: false, progress: 0,
      jobId: null, takeId: null, state: '', pct: 0,
      error: null, code: '', segments: [], language: '', languageProbability: 0,
      durationMs: 0, translationTarget: 'en', translationText: '',
      translationSource: '', translationLoading: false, translationError: '',
      polling: false, _timer: null, _deadline: 0,
      _mgTargetNode: null,   // Media Gallery node receiving this upload
    },

    // ── Alpine lifecycle ──

    destroy() {
      this.stopUploadPolling();
      if (this.recording) { try { this.stop(); } catch (e) { /* ignore */ } }
      this._closeSocket();
      this._cleanupStream();
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
    },

    // ══════════════════════════════════════════════════════════════════════════
    // Controls — single toggle (replaces Start / Stop)
    // ══════════════════════════════════════════════════════════════════════════

    toggleRecording() {
      if (this.recording || this.connecting) this.stop();
      else this.start();
    },

    // ── mic pipeline ──
    async start() {
      if (this.recording || this.connecting) return;

      this.error = null;
      this.saved = null;

      this.normalizing = false; this.normalized = null; this.normalizeMessage = '';
      this.vadRunning = false; this.vadSegments = []; this.vadTotalSpeechMs = 0; this.vadMessage = '';
      this.transcribing = false; this.transcribeMessage = '';
      this.languageDetected = ''; this.languageProbability = 0; this.transcriptSegments = [];
      this.liveTranscriptText = ''; this.liveSegmentCount = 0; this.liveLanguage = '';
      this.liveActive = true;
      this.activeTab = 'transcribe';
      this._micSpeakers = null;

      this.chunksSent = 0; this.chunksReceived = 0; this.bytesReceived = 0;
      this.serverDurationMs = 0; this.elapsedMs = 0;

      this._sendQueue = Promise.resolve();
      this.sessionId = this._newSessionId();
      this.connecting = true;

      // 1. microphone permission + stream
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (err) {
        this.connecting = false;
        this.liveActive = false;
        this.error = this._micErrorMessage(err);
        return;
      }
      this._stream = stream;

      // 2. websocket
      try {
        await this._openSocket();
      } catch (err) {
        this._cleanupStream();
        this.connecting = false;
        this.liveActive = false;
        this.error = 'WebSocket connection failed: ' + this._errMessage(err);
        return;
      }

      // 3. MediaRecorder
      const mime = this._pickMime();
      this._mime = mime;
      try {
        this._recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      } catch (err) {
        this._closeSocket();
        this._cleanupStream();
        this.connecting = false;
        this.liveActive = false;
        this.error = 'MediaRecorder init failed: ' + this._errMessage(err);
        return;
      }

      this._recorder.ondataavailable = (e) => {
        if (!e.data || e.data.size === 0) return;
        this.chunksSent += 1;
        this._sendQueue = this._sendQueue
          .then(() => e.data.arrayBuffer())
          .then((buf) => {
            if (this._ws && this._ws.readyState === WebSocket.OPEN) this._ws.send(buf);
          })
          .catch(() => { /* socket gone; onclose handles UI */ });
      };

      // 4. control message, then capture
      this._ws.send(JSON.stringify({
        type: 'start',
        mime: mime || 'unknown',
        client_ts: Date.now(),
        session: this.sessionId,
        translation_target: this.micTranslationTarget || '',
      }));

      this._recorder.start(100);
      this._startTs = performance.now();
      this._timer = setInterval(() => { this.elapsedMs = performance.now() - this._startTs; }, 100);

      this.connecting = false;
      this.recording = true;
    },

    async stop() {
      if (!this.recording) return;
      this.recording = false;

      if (this._timer) { clearInterval(this._timer); this._timer = null; }

      if (this._recorder && this._recorder.state !== 'inactive') {
        const stopped = new Promise((resolve) => { this._recorder.onstop = resolve; });
        try { this._recorder.stop(); } catch (e) { /* already stopped */ }
        await stopped;
      }

      await this._sendQueue;

      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ type: 'stop', client_ts: Date.now() }));
      }

      this.liveActive = false;
      this._cleanupStream();
    },

    // ══════════════════════════════════════════════════════════════════════════
    // WebSocket
    // ══════════════════════════════════════════════════════════════════════════

    _openSocket() {
      return new Promise((resolve, reject) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = proto + '//' + location.host + '/ws/studio/' + this.sessionId + '/';

        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';

        let settled = false;

        ws.onopen = () => { this._ws = ws; settled = true; resolve(); };
        ws.onerror = () => { if (!settled) { settled = true; reject(new Error('socket error')); } };

        ws.onclose = (e) => {
          this._ws = null;
          this.liveActive = false;

          if (this.recording) {
            this.recording = false;
            if (this._timer) { clearInterval(this._timer); this._timer = null; }
            this._cleanupStream();
            this.error = 'Connection lost during recording (code ' + e.code + ').';
          }

          if (!settled) {
            settled = true;
            reject(new Error('closed before open (code ' + e.code + ')'));
          }
        };

        ws.onmessage = (evt) => {
          if (evt.data instanceof ArrayBuffer) {
            this._handleTtsAudio(evt.data);
          } else {
            this._handleServerMessage(evt);
          }
        };

        setTimeout(() => {
          if (!settled) {
            try { ws.close(); } catch (e) { /* ignore */ }
            settled = true;
            reject(new Error('handshake timeout'));
          }
        }, 8000);
      });
    },

    _closeSocket() {
      if (this._ws) { try { this._ws.close(); } catch (e) { /* ignore */ } this._ws = null; }
    },

    _handleServerMessage(evt) {
      let msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }

      switch (msg.type) {
        case 'connected':
          this.maxBytes = msg.max_bytes || this.maxBytes;
          break;

        case 'started':
          this.maxBytes = msg.max_bytes || this.maxBytes;
          break;

        case 'stats':
          this.chunksReceived = msg.chunks || 0;
          this.bytesReceived = msg.bytes || 0;
          this.serverDurationMs = msg.duration_ms || 0;
          break;

        case 'saved':
          this.saved = msg;
          if (msg.take_id) this.takeId = msg.take_id;
          // Auto-open a tab for the new mic recording.
          if (msg.take_id && msg.filename) {
            this.openMicTab(msg.take_id, msg.filename, msg.duration_ms || 0);
          }
          break;

        // ── Phase 5.5: live rolling preview ──
        case 'live_transcript_update':
          if (!this.recording) break;
          this.liveTranscriptText = msg.text || '';
          this.liveSegmentCount = msg.segment_count || 0;
          this.liveLanguage = msg.language ? String(msg.language).toUpperCase() : '';
          break;

        // ── Phase 3 ──
        case 'normalizing':
          this.normalizing = true; this.normalized = null;
          this.normalizeMessage = msg.message || 'Normalizing audio…';
          break;

        case 'normalized':
          this.normalizing = false; this.normalized = msg; this.normalizeMessage = '';
          break;

        // ── Phase 4 ──
        case 'vad_started':
          this.vadRunning = true; this.vadSegments = []; this.vadTotalSpeechMs = 0;
          this.vadMessage = msg.message || 'Detecting speech segments…';
          break;

        case 'vad_complete':
          this.vadRunning = false;
          this.vadSegments = msg.segments || [];
          this.vadTotalSpeechMs = msg.total_speech_ms || 0;
          this.vadMessage = '';
          break;

        // ── Phase 5 ──
        case 'transcribing_started':
          this.transcribing = true; this.transcriptSegments = [];
          this.languageDetected = ''; this.languageProbability = 0;
          this.transcribeMessage = msg.message || 'Transcribing…';
          this._micSpeakers = null;
          break;

        case 'transcribing_complete':
          this.transcribing = false;
          this.languageDetected = msg.language ? String(msg.language).toUpperCase() : 'UNKNOWN';
          this.languageProbability = msg.language_probability || 0;
          if (Array.isArray(msg.segments) && msg.segments.length > 0) {
            this.transcriptSegments = msg.segments;
          }
          this.transcribeMessage = '';
          break;

        case 'error':
          if (msg.saved) this.saved = msg.saved;
          if (msg.stage === 'normalization') { this.normalizing = false; this.normalizeMessage = ''; }
          if (msg.stage === 'vad') { this.vadRunning = false; this.vadMessage = ''; }
          if (msg.stage === 'transcription') { this.transcribing = false; this.transcribeMessage = ''; }
          if (msg.stage === 'translation') { this.upload.translationLoading = false; this.micTranslationLoading = false; }
          if (msg.stage === 'tts') { this.upload.translationLoading = false; this.micTranslationLoading = false; this.ttsPlaying = false; }
          this.error = msg.message || 'Server error.';
          if (this.recording) { try { this.stop(); } catch (e) { /* ignore */ } }
          break;

        // ── Phase 9/10: Translation + TTS ──
        case 'translation_started':
          if (msg.stage === 'mic') {
            this.micTranslationLoading = true;
            this.micTranslationError = '';
            this.micTranslationText = '';
          } else {
            this.upload.translationLoading = true;
            this.upload.translationError = '';
          }
          break;

        case 'translation_complete':
          this.micTranslationSource = msg.source_language || '';
          this.micTranslationTarget = msg.target_language || '';
          this.micTranslationText = msg.text || '';
          this.ttsPlaying = true;
          break;

        case 'tts_started':
          this.micTranslationLoading = true;
          break;

        case 'tts_complete':
          this.micTranslationLoading = false;
          this.ttsPlaying = false;
          break;
      }
    },

    _handleTtsAudio(arrayBuffer) {
      if (!this._ttsAudioContext) {
        this._ttsAudioContext = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: 16000,
        });
      }
      const ctx = this._ttsAudioContext;
      if (ctx.state === 'suspended') ctx.resume();

      const audioData = new Int16Array(arrayBuffer);
      const float32 = new Float32Array(audioData.length);
      for (let i = 0; i < audioData.length; i++) {
        float32[i] = audioData[i] / 32768.0;
      }
      const buffer = ctx.createBuffer(1, float32.length, 16000);
      buffer.copyToChannel(float32, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    },

    // ══════════════════════════════════════════════════════════════════════════
    // Multi-tab system
    // ══════════════════════════════════════════════════════════════════════════

    openMicTab(takeId, filename, durationMs) {
      const existing = this.tabs.find(t => t.takeId === takeId && t.source === 'mic');
      if (existing) {
        this.activeTabId = existing.id;
        this.transcriptSegments = existing.segments || [];
        this.languageDetected = existing.language || '';
        this.languageProbability = existing.languageProbability || 0;
        this.saved = { ...existing.saved, duration_ms: durationMs };
        this.takeId = takeId;
        return;
      }
      const tab = {
        id: 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        title: filename,
        source: 'mic',
        takeId: takeId,
        segments: [...this.transcriptSegments],
        language: this.languageDetected || '',
        languageProbability: this.languageProbability,
        durationMs: durationMs || 0,
        saved: { ...this.saved, duration_ms: durationMs },
        translationTarget: this.micTranslationTarget,
        translationText: this.micTranslationText,
        translationSource: this.micTranslationSource,
        translationLoading: false,
        translationError: '',
      };
      this.tabs.push(tab);
      this.activeTabId = tab.id;
    },

    async openExistingTab(takeId, filename) {
      // Don't duplicate.
      const existing = this.tabs.find(t => t.takeId === takeId && t.source === 'upload');
      if (existing) {
        this.activeTabId = existing.id;
        this._applyTabToUI(existing);
        return;
      }

      // Fetch transcript from backend.
      try {
        const resp = await fetch('/studio/takes/' + takeId + '/transcript/?format=json', {
          headers: { 'Accept': 'application/json' },
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const d = await resp.json();

        const tab = {
          id: 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          title: filename,
          source: 'upload',
          takeId: takeId,
          segments: Array.isArray(d.segments) ? d.segments : [],
          language: d.language || '',
          languageProbability: d.language_probability || 0,
          durationMs: d.duration_ms || 0,
          saved: null,
          translationTarget: 'en',
          translationText: '',
          translationSource: d.language || '',
          translationLoading: false,
          translationError: '',
        };
        this.tabs.push(tab);
        this.activeTabId = tab.id;
        this._applyTabToUI(tab);
      } catch (err) {
        this.error = 'Could not load transcription: ' + this._errMessage(err);
      }
    },

    closeTab(tabId) {
      this.tabs = this.tabs.filter(t => t.id !== tabId);
      if (this.activeTabId === tabId) {
        this.activeTabId = this.tabs.length > 0 ? this.tabs[0].id : null;
        if (this.activeTabId) this._applyTabToUI(this.tabs.find(t => t.id === this.activeTabId));
        else {
          this.transcriptSegments = [];
          this.languageDetected = '';
          this.languageProbability = 0;
          this.saved = null;
          this.takeId = '';
        }
      }
    },

    get activeTab() {
      return this.tabs.find(t => t.id === this.activeTabId) || null;
    },

    _applyTabToUI(tab) {
      this.transcriptSegments = tab.segments || [];
      this.languageDetected = tab.language || '';
      this.languageProbability = tab.languageProbability || 0;
      this.takeId = tab.takeId || '';
      this.saved = tab.saved || null;
      this.micTranslationTarget = tab.translationTarget || 'en';
      this.micTranslationText = tab.translationText || '';
      this.micTranslationSource = tab.translationSource || '';
    },

    // ══════════════════════════════════════════════════════════════════════════
    // Phase 7: upload controls (Media Gallery routed)
    // ══════════════════════════════════════════════════════════════════════════

    async startUpload() {
      const u = this.upload;
      if (!u.file || u.uploading || u.polling) return;

      u.error = null; u.code = '';
      u.segments = []; u.language = ''; u.languageProbability = 0; u.durationMs = 0;
      u.progress = 0; u.pct = 0; u.state = 'uploading';
      u.uploading = true;

      const form = new FormData();
      form.append('file', u.file, u.name);

      try {
        const res = await this._xhrUpload('/studio/upload/', form, (pct) => { u.progress = pct; });
        if (!res.ok) {
          u.state = '';
          u.error = res.body.error || ('Upload failed (HTTP ' + res.status + ').');
          u.code = res.body.code || '';
          return;
        }
        u.jobId = res.body.job_id || null;
        u.takeId = res.body.take_id || null;
        u.state = res.body.status || 'queued';
        u.pct = 0;
        if (!u.jobId) {
          u.error = 'Server accepted the file but returned no job id.';
          return;
        }

        // Notify Media Gallery of the new file node.
        const mg = Alpine.store('tsGallery');
        const target = u._mgTargetNode || mg.roots[0];
        if (target && target.children !== undefined) {
          // Register the uploaded file placeholder in the target folder.
          mg.addFileToNode(target, {
            name: u.name, takeId: u.takeId, size: u.size, durationMs: 0,
            mime: u.file.type || 'audio/mpeg', hasTranscript: false,
          });
        }
        u._mgTargetNode = null;

        this.startUploadPolling();
      } catch (err) {
        u.state = '';
        u.error = 'Network error during upload: ' + this._errMessage(err);
      } finally {
        u.uploading = false;
      }
    },

    _xhrUpload(url, form, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('X-CSRFToken', this._csrfToken());
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.timeout = 120000;
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
          let body = {};
          try { body = JSON.parse(xhr.responseText); } catch (e) { /* non-JSON */ }
          resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body });
        };
        xhr.onerror = () => reject(new Error('network error'));
        xhr.ontimeout = () => reject(new Error('upload timed out after 120s'));
        xhr.send(form);
      });
    },

    startUploadPolling() {
      const u = this.upload;
      if (!u.jobId) return;
      this.stopUploadPolling();
      u.polling = true;
      u._deadline = Date.now() + 20 * 60 * 1000;

      const tick = async () => {
        if (!this.upload.polling) return;
        try {
          const resp = await fetch('/studio/jobs/' + u.jobId + '/', {
            headers: { 'Accept': 'application/json' },
          });
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const d = await resp.json();

          u.state = d.state || u.state;
          u.pct = d.progress_pct || 0;

          if (d.state === 'done') {
            this.stopUploadPolling();
            await this.fetchUploadTranscript();
            return;
          }
          if (d.state === 'failed') {
            this.stopUploadPolling();
            u.error = d.last_error || 'Transcription failed.';
            return;
          }
          if (d.state === 'cancelled') {
            this.stopUploadPolling();
            u.error = 'Job was cancelled.';
            return;
          }
          if (Date.now() > u._deadline) {
            this.stopUploadPolling();
            u.error = 'Still ' + (d.state || 'processing') + ' after 20 minutes. '
              + 'Is the worker running? (cd backend && python manage.py tsworker)';
            return;
          }
          u._timer = setTimeout(tick, 1500);
        } catch (err) {
          if (Date.now() > u._deadline) {
            this.stopUploadPolling();
            u.error = 'Polling failed: ' + this._errMessage(err);
            return;
          }
          u._timer = setTimeout(tick, 3000);
        }
      };

      u._timer = setTimeout(tick, 800);
    },

    stopUploadPolling() {
      const u = this.upload;
      if (u._timer) { clearTimeout(u._timer); u._timer = null; }
      u.polling = false;
    },

    async fetchUploadTranscript() {
      const u = this.upload;
      try {
        const resp = await fetch('/studio/jobs/' + u.jobId + '/transcript/', {
          headers: { 'Accept': 'application/json' },
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const d = await resp.json();
        u.segments = Array.isArray(d.segments) ? d.segments : [];
        u.language = d.language ? String(d.language).toUpperCase() : '';
        u.languageProbability = d.language_probability || 0;
        u.durationMs = d.duration_ms || 0;

        // Open an upload tab when transcription completes.
        const tab = {
          id: 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          title: u.name,
          source: 'upload',
          takeId: u.takeId,
          segments: u.segments,
          language: u.language,
          languageProbability: u.languageProbability,
          durationMs: u.durationMs,
          saved: null,
          translationTarget: u.translationTarget,
          translationText: u.translationText,
          translationSource: u.translationSource,
          translationLoading: false,
          translationError: '',
        };
        this.tabs.push(tab);
        this.activeTabId = tab.id;
        this._applyTabToUI(tab);

        // Update Media Gallery node to mark as transcribed.
        this._updateMgNodeTranscribed(u.takeId);

      } catch (err) {
        u.error = 'Transcript fetch failed: ' + this._errMessage(err);
      }
    },

    _updateMgNodeTranscribed(takeId) {
      const mg = Alpine.store('tsGallery');
      const mark = (children) => {
        for (const c of children || []) {
          if (c.takeId === takeId) { c.hasTranscript = true; mg.save(); return true; }
          if (c.children && mark(c.children)) return true;
        }
        return false;
      };
      for (const root of mg.roots) { if (mark(root.children)) return; }
    },

    // ── Translation ──
    _apiPost(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-CSRFToken': this._csrfToken(),
        },
        body: JSON.stringify(body),
      });
    },

    async translateUpload() {
      const u = this.upload;
      if (!u.takeId || u.translationLoading) return;

      u.translationLoading = true;
      u.translationError = '';
      u.translationText = '';
      u.translationSource = u.language || 'en';

      try {
        const resp = await this._apiPost('/studio/translate/', {
          take_id: u.takeId,
          target_language: u.translationTarget,
        });
        if (!resp.ok) {
          const d = await resp.json().catch(() => ({}));
          throw new Error(d.error || 'Translation failed (HTTP ' + resp.status + ').');
        }
        const d = await resp.json();
        u.translationSource = d.source_language || u.translationSource;
        u.translationTarget = d.target_language || u.translationTarget;
        u.translationText = d.text || '';
      } catch (err) {
        u.translationError = this._errMessage(err);
      } finally {
        u.translationLoading = false;
      }
    },

    async translateMic() {
      if (!this.takeId || this.micTranslationLoading) return;

      this.micTranslationLoading = true;
      this.micTranslationError = '';
      this.micTranslationText = '';

      try {
        const resp = await this._apiPost('/studio/translate/', {
          take_id: this.takeId,
          target_language: this.micTranslationTarget,
        });
        if (!resp.ok) {
          const d = await resp.json().catch(() => ({}));
          throw new Error(d.error || 'Translation failed (HTTP ' + resp.status + ').');
        }
        const d = await resp.json();
        this.micTranslationSource = d.source_language || this.micTranslationSource;
        this.micTranslationTarget = d.target_language || this.micTranslationTarget;
        this.micTranslationText = d.text || '';

        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
          this._ws.send(JSON.stringify({
            type: 'tts_request',
            take_id: this.takeId,
            target_language: this.micTranslationTarget,
          }));
        }
      } catch (err) {
        this.micTranslationError = this._errMessage(err);
      } finally {
        this.micTranslationLoading = false;
      }
    },

    stopTtsPlayback() {
      this.ttsPlaying = false;
      this.micTranslationLoading = false;
      if (this._ttsAudioContext) {
        try { this._ttsAudioContext.close(); } catch (e) { /* ignore */ }
        this._ttsAudioContext = null;
      }
    },

    // ══════════════════════════════════════════════════════════════════════════
    // Advanced transcription display helpers
    // ══════════════════════════════════════════════════════════════════════════

    _speakerLabels(segs) {
      const labels = {};
      let current = 1;
      let lastEnd = null;
      for (const s of segs || []) {
        if (s.speaker_id) {
          labels[s.index] = s.speaker_id;
        } else if (lastEnd !== null && s.start_ms - lastEnd > 1500) {
          current += 1;
          labels[s.index] = 'Speaker ' + current;
        } else {
          labels[s.index] = 'Speaker ' + current;
        }
        lastEnd = s.end_ms;
      }
      return labels;
    },

    getSpeaker(index) {
      if (!this._micSpeakers) this._micSpeakers = this._speakerLabels(this.transcriptSegments);
      return this._micSpeakers[index] || 'Speaker 1';
    },

    speakerColor(speaker) {
      const colors = ['bg-indigo-500/20 text-indigo-300', 'bg-cyan-500/20 text-cyan-300',
                      'bg-emerald-500/20 text-emerald-300', 'bg-rose-500/20 text-rose-300',
                      'bg-amber-500/20 text-amber-300', 'bg-purple-500/20 text-purple-300'];
      let hash = 0;
      for (let i = 0; i < speaker.length; i++) {
        hash = ((hash << 5) - hash) + speaker.charCodeAt(i);
        hash = hash & hash;
      }
      return colors[Math.abs(hash) % colors.length];
    },

    speakerList() {
      const set = new Set();
      for (const s of this.transcriptSegments || []) set.add(this.getSpeaker(s.index));
      return Array.from(set).sort();
    },

    filteredSegments() {
      if (!this.activeSpeaker) return this.transcriptSegments;
      return this.transcriptSegments.filter(s => this.getSpeaker(s.index) === this.activeSpeaker);
    },

    // ── copy / export ──
    copyTranscript() {
      const lines = this.transcriptSegments.map(s => {
        const t = this.fmtSegTime(s.start_ms) + ' → ' + this.fmtSegTime(s.end_ms);
        return this.showTimestamps ? '[' + t + '] ' + s.text : s.text;
      }).join('\n');
      navigator.clipboard.writeText(lines).then(() => {
        const btn = event && event.currentTarget;
        if (btn) { const old = btn.innerHTML; btn.innerHTML = '✓ Copied'; setTimeout(() => { btn.innerHTML = old; }, 1200); }
      });
    },

    exportSrt() {
      const lines = [];
      for (let i = 0; i < this.transcriptSegments.length; i++) {
        const s = this.transcriptSegments[i];
        lines.push(i + 1);
        lines.push(this.fmtSrt(s.start_ms) + ' --> ' + this.fmtSrt(s.end_ms));
        lines.push(s.text);
        lines.push('');
      }
      navigator.clipboard.writeText(lines.join('\n')).then(() => {
        const btn = event && event.currentTarget;
        if (btn) { const old = btn.innerHTML; btn.innerHTML = '✓ SRT copied'; setTimeout(() => { btn.innerHTML = old; }, 1200); }
      });
    },

    // ══════════════════════════════════════════════════════════════════════════
    // Status / pipeline
    // ══════════════════════════════════════════════════════════════════════════

    pipelineBusy() {
      return this.connecting || this.recording || this.normalizing || this.vadRunning || this.transcribing;
    },

    pipelineLabel() {
      if (this.connecting) return 'Connecting…';
      if (this.recording) {
        return this.liveTranscriptText ? 'Recording… (live)' : 'Recording…';
      }
      if (this.normalizing) return 'Normalizing…';
      if (this.vadRunning) return 'Detecting speech…';
      if (this.transcribing) return 'Transcribing…';
      if (this.transcriptSegments.length > 0) return 'Ready';
      if (this.saved) return 'Saved';
      return 'Idle';
    },

    uploadStatusLabel() {
      const u = this.upload;
      if (u.uploading) return 'Uploading… ' + u.progress + '%';
      if (u.polling) {
        const names = {
          queued: 'Queued (waiting for worker)',
          normalizing: 'Normalizing (FFmpeg)…',
          segmenting: 'Detecting speech (Silero VAD)…',
          transcribing: 'Transcribing (Faster-Whisper)…',
        };
        const base = names[u.state] || (u.state || 'Processing');
        return u.pct ? base + ' ' + u.pct + '%' : base;
      }
      if (u.state === 'done') return 'Complete';
      if (u.state === 'failed') return 'Failed';
      if (u.state === 'cancelled') return 'Cancelled';
      if (u.file) return 'Ready to upload';
      return 'No file selected';
    },

    // ══════════════════════════════════════════════════════════════════════════
    // Helpers
    // ══════════════════════════════════════════════════════════════════════════

    _csrfToken() {
      const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    },

    _newSessionId() {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
      return 'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
    },

    _pickMime() {
      const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
      ];
      if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
      for (const candidate of candidates) {
        if (MediaRecorder.isTypeSupported(candidate)) return candidate;
      }
      return '';
    },

    _errMessage(err) { return err && err.message ? err.message : String(err); },

    _micErrorMessage(err) {
      switch (err && err.name) {
        case 'NotAllowedError':
          return 'Microphone permission denied. Allow mic access for this site, then try again.';
        case 'NotFoundError':
        case 'DevicesNotFoundError':
          return 'No microphone found. Connect one and reload the page.';
        case 'NotReadableError':
        case 'TrackStartError':
          return 'Microphone is already in use by another application.';
        case 'SecurityError':
          return 'Microphone requires a secure context. Open http://localhost:PORT, not an IP address.';
        case 'OverconstrainedError':
          return 'Microphone does not support the requested audio constraints.';
        default:
          return 'Microphone error: ' + this._errMessage(err);
      }
    },

    _cleanupStream() {
      if (this._stream) {
        this._stream.getTracks().forEach((track) => {
          try { track.stop(); } catch (e) { /* ignore */ }
        });
        this._stream = null;
      }
    },

    fmtTime(ms) {
      ms = Math.max(0, Math.floor(ms || 0));
      const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
      const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
      const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
      const d = String(Math.floor(ms / 100) % 10);
      return h + ':' + m + ':' + s + '.' + d;
    },

    fmtSegTime(ms) {
      ms = Math.max(0, Math.floor(ms || 0));
      const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
      const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
      const frac = String(ms % 1000).padStart(3, '0');
      return m + ':' + s + '.' + frac;
    },

    fmtSrt(ms) {
      ms = Math.max(0, Math.floor(ms || 0));
      const h = Math.floor(ms / 3600000);
      const m = Math.floor(ms / 60000) % 60;
      const s = Math.floor(ms / 1000) % 60;
      const milli = ms % 1000;
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':'
        + String(s).padStart(2, '0') + ',' + String(milli).padStart(3, '0');
    },

    fmtBytes(n) {
      n = Number(n) || 0;
      if (n === 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      let i = 0, v = n;
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
      return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
    },

    fmtSampleRate(hz) {
      hz = Number(hz) || 0;
      if (hz >= 1000) return (hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1) + ' kHz';
      return hz + ' Hz';
    },
  }));

});
// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const styles = readFileSync(resolve(process.cwd(), 'index.css'), 'utf8');
const body = page.match(/<body>([\s\S]*)<\/body>/)[1];

const savedReport = {
  report_id: 'report-12345678',
  created_at: '2026-07-31T10:00:00Z',
  language: 'en',
  model: 'legacy-private-model',
  session_previews: [{
    session_id: 'session-1',
    channel_name: '<img src=x onerror="window.attacked=true">',
    guild_name: '<script>window.attacked=true</script>',
  }],
  content: [
    '## Summary',
    '- **Decision:** keep issue #123 redacted as ****.',
    '- <img src=x onerror="window.attacked=true">',
    '<script>window.attacked=true</script>',
  ].join('\n'),
};

async function loadApp() {
  vi.resetModules();
  document.body.innerHTML = body;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    setTransform: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
  });
  global.requestAnimationFrame = vi.fn();
  global.fetch = vi.fn();
  return import('./main.js');
}

async function showSavedTranscript(app, transcripts, sessionStatus = 'closed') {
  const sessionId = 'replay-session';
  app.renderSessionSelects(null, [{
    session_id: sessionId,
    channel_name: 'Replay',
    utterance_count: transcripts.length,
  }]);
  fetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      session: { session_id: sessionId, status: sessionStatus },
      recording: { available: false },
      transcripts,
    }),
  });
  const select = document.getElementById('sessionSelect');
  select.value = sessionId;
  select.dispatchEvent(new Event('change'));
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.transcript-entry')).toHaveLength(transcripts.length);
  });
}

function installActiveAudioMocks() {
  const sockets = [];
  const audioContexts = [];

  class MockAudioContext {
    constructor() {
      this.currentTime = 0;
      this.destination = {};
      this.sources = [];
      this.createdFrameCounts = [];
      audioContexts.push(this);
    }

    createBuffer(channels, frameCount) {
      this.createdFrameCounts.push(frameCount);
      const data = Array.from({ length: channels }, () => new Float32Array(frameCount));
      return { getChannelData: (channel) => data[channel] };
    }

    createBufferSource() {
      const source = {
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      this.sources.push(source);
      return source;
    }

    resume = vi.fn().mockResolvedValue();

    close = vi.fn().mockResolvedValue();
  }

  class MockWebSocket {
    static CONNECTING = 0;

    static OPEN = 1;

    static CLOSING = 2;

    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = MockWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }

    open() {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }

    serverMessage(data) {
      this.onmessage?.({ data });
    }

    send(message) {
      this.sent.push(JSON.parse(message));
    }

    close() {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.();
    }
  }

  vi.stubGlobal('AudioContext', MockAudioContext);
  vi.stubGlobal('WebSocket', MockWebSocket);
  return { audioContexts, sockets };
}

async function makeActiveAudioAvailable(mocks, sessionId, durationSeconds) {
  const socket = mocks.sockets.at(-1);
  socket.open();
  socket.serverMessage(JSON.stringify({
    type: 'ready',
    session_id: sessionId,
    offset: 0,
    captured_bytes: durationSeconds * 48000 * 4,
    revision: 1,
    reset: false,
    sample_rate: 48000,
    channels: 2,
    sample_width: 2,
  }));
  const size = durationSeconds * 48000 * 4;
  socket.serverMessage(JSON.stringify({
    type: 'chunk', id: 1, offset: 0, size, revision: 1,
  }));
  socket.serverMessage(new ArrayBuffer(size));
  await vi.waitFor(() => {
    expect(document.getElementById('sessionRecording').dataset.capturedThrough)
      .toBe(String(durationSeconds));
  });
  return socket;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('workspace structure and accessibility', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('uses a transcription-first workspace with offline-safe assets and secondary settings', async () => {
    await loadApp();

    expect(document.querySelector('.connection-toolbar')).not.toBeNull();
    expect(document.querySelector('.workspace-grid')).not.toBeNull();
    expect(document.querySelector('.primary-workspace .transcription-panel')).not.toBeNull();
    expect(document.querySelector('.workspace-sidebar details.settings-panel')).not.toBeNull();
    expect(document.querySelector('.settings-panel').open).toBe(false);
    expect(styles).not.toMatch(/@import|fonts\.googleapis|https?:\/\//i);
    expect(styles).toContain('@media (max-width: 980px)');
    expect(styles).toContain('@media (max-width: 640px)');
    expect(document.getElementById('reportDisplayContainer').parentElement).toBe(document.body);
    expect(document.getElementById('reportDialog').getAttribute('role')).toBe('dialog');
    expect(document.getElementById('reportDialog').getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById('exportMdBtn').textContent).toBe('Export to Markdown');
    expect(document.getElementById('exportTxtBtn').textContent).toBe('Export to Text');
  });

  it('provides a fixed support link to Buy Me a Coffee', async () => {
    await loadApp();
    const supportLink = document.querySelector('.support-link');

    expect(supportLink.href).toBe('https://buymeacoffee.com/se67013');
    expect(supportLink.target).toBe('_blank');
    expect(supportLink.rel).toContain('noopener');
    expect(supportLink.textContent).toContain('Buy me a coffee');
    expect(styles).toMatch(/\.support-link\s*\{[\s\S]*position:\s*fixed/);
  });

  it('provides a pressable and keyboard accessible report language select', async () => {
    await loadApp();
    const root = document.getElementById('reportLanguageSelect');
    const trigger = root.querySelector('.select-trigger');
    const content = root.querySelector('.select-content');
    const positioner = root.querySelector('.select-positioner');

    expect(trigger.getAttribute('role')).toBe('combobox');
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    trigger.click();
    const english = root.querySelector('[data-value="en"]');
    const hebrew = root.querySelector('[data-value="he"]');
    expect(positioner.hidden).toBe(false);
    expect(document.activeElement).toBe(content);
    expect(content.getAttribute('aria-activedescendant')).toBe(english.id);

    hebrew.dispatchEvent(new Event('pointermove', { bubbles: true }));
    hebrew.click();
    expect(document.getElementById('reportLangSelect').value).toBe('he');
    expect(root.querySelector('.select-value').textContent).toBe('Hebrew (עברית)');
    expect(hebrew.getAttribute('aria-selected')).toBe('true');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);

    trigger.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      bubbles: true,
    }));
    expect(content.getAttribute('aria-activedescendant')).toBe(english.id);
    content.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
    }));
    expect(document.getElementById('reportLangSelect').value).toBe('en');
    expect(root.querySelector('.select-value').textContent).toBe('English');

    trigger.click();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('applies the wiki select anatomy to every dropdown', async () => {
    await loadApp();
    const nativeSelects = Array.from(document.querySelectorAll('select'));
    const roots = Array.from(document.querySelectorAll('[data-custom-select]'));

    expect(nativeSelects.map((select) => select.id)).toEqual([
      'channelSelect',
      'sessionSelect',
      'reportLangSelect',
    ]);
    expect(roots).toHaveLength(nativeSelects.length);
    for (const select of nativeSelects) {
      const root = select.closest('[data-custom-select]');
      const trigger = root.querySelector('.select-trigger');
      const content = root.querySelector('.select-content');
      expect(select.classList.contains('select-native')).toBe(true);
      expect(select.getAttribute('aria-hidden')).toBe('true');
      expect(trigger.getAttribute('role')).toBe('combobox');
      expect(trigger.getAttribute('aria-controls')).toBe(content.id);
      expect(content.getAttribute('role')).toBe('listbox');
    }
    expect(document.querySelector('#channelSelect + .select-control .select-trigger').disabled)
      .toBe(true);
    expect(document.querySelector('#sessionSelect + .select-control .select-trigger').disabled)
      .toBe(false);
  });

  it('keeps dynamic channel groups and disabled state synchronized', async () => {
    const app = await loadApp();
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        channels: [
          {
            channel_id: 'channel-1',
            channel_name: 'Planning',
            guild_id: 'guild-1',
            guild_name: 'Engineering',
          },
          {
            channel_id: 'channel-2',
            channel_name: 'Support',
            guild_id: 'guild-2',
            guild_name: 'Operations',
          },
        ],
      }),
    });

    app.handleEvent({
      type: 'status',
      state: 'ready',
      connected: false,
      bot_ready: true,
    });

    const channelRoot = document.getElementById('channelSelect').closest('[data-custom-select]');
    await vi.waitFor(() => {
      expect(channelRoot.querySelectorAll('[role="option"]')).toHaveLength(3);
    });
    expect(channelRoot.querySelector('.select-trigger').disabled).toBe(false);
    expect(Array.from(channelRoot.querySelectorAll('.select-group-label')).map(
      (label) => label.textContent,
    )).toEqual(['Engineering', 'Operations']);

    channelRoot.querySelector('.select-trigger').click();
    channelRoot.querySelector('[data-value="channel-2"]').click();
    expect(document.getElementById('channelSelect').value).toBe('channel-2');
    expect(channelRoot.querySelector('.select-value').textContent).toBe('Support');
    expect(document.getElementById('toggleBtn').disabled).toBe(false);
  });

  it('renders report sessions as labelled checkboxes without a modifier-key multiple select', async () => {
    const app = await loadApp();
    app.renderSessionSelects(
      {
        session_id: 'live-session',
        channel_name: 'Standup',
        guild_name: 'Engineering',
      },
      [{
        session_id: 'past-session',
        channel_name: 'Planning',
        guild_name: 'Engineering',
        started_at: '2026-07-30T10:00:00Z',
        utterance_count: 14,
      }],
    );

    const group = document.getElementById('reportSessionsSelect');
    const checkboxes = Array.from(group.querySelectorAll('input[type="checkbox"]'));
    expect(checkboxes).toHaveLength(2);
    expect(group.querySelector('select')).toBeNull();
    expect(document.querySelector('.report-session-fieldset legend').textContent).toBe('Sessions to include');
    expect(checkboxes.every((checkbox) => checkbox.closest('label'))).toBe(true);
    expect(document.getElementById('reportSessionsHelp').textContent).toContain('No keyboard modifier');
    const sessionRoot = document.getElementById('sessionSelect').closest('[data-custom-select]');
    expect(sessionRoot.querySelector('.select-value').textContent).toBe('Live - Standup');
    sessionRoot.querySelector('.select-trigger').click();
    expect(sessionRoot.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(sessionRoot.querySelector('[data-value="past-session"] .select-item-text').textContent)
      .toContain('Planning');
  });
});

describe('active session discovery', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('adds the active report checkbox after the first persisted transcript', async () => {
    const app = await loadApp();
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ active_session: null, past_sessions: [] }),
    });

    await app.loadSessions();

    expect(document.querySelector('#reportSessionsSelect input')).toBeNull();
    expect(document.getElementById('sessionStatus').textContent).toBe('Empty');

    let resolveRefresh;
    fetch.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = resolve;
    }));

    app.handleEvent({
      type: 'transcript',
      utterance_id: 'utterance-1',
      speaker_name: 'Ada',
      text: 'The first persisted line',
      finalized: true,
    });
    app.handleEvent({
      type: 'transcript',
      utterance_id: 'utterance-2',
      speaker_name: 'Grace',
      text: 'A concurrent finalized line',
      finalized: true,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    resolveRefresh({
      ok: true,
      json: async () => ({
        active_session: {
          session_id: 'active-session',
          channel_name: 'Standup',
          guild_name: 'Engineering',
        },
        past_sessions: [],
      }),
    });
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        session: { session_id: 'active-session', status: 'active' },
        recording: { available: false },
        transcripts: [{
          utterance_id: 'utterance-1',
          speaker_name: 'Ada',
          text: 'The first persisted line',
          start_seconds: 1,
          end_seconds: 2,
        }],
      }),
    });

    await vi.waitFor(() => {
      expect(document.querySelector('#reportSessionsSelect input').value).toBe('active-session');
    });
    expect(document.querySelector('.session-check-name').textContent).toBe('Live - Standup');
    expect(document.getElementById('sessionStatus').textContent).toBe('1 available');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe('session recording playback', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('plays the exact completed-session transcript interval', async () => {
    await loadApp();
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const detail = {
      session: { session_id: 'past-session', status: 'closed' },
      recording: {
        available: true,
        url: '/sessions/past-session/audio',
        duration_seconds: 14,
      },
      transcripts: [{
        utterance_id: 'u1',
        speaker_name: 'Ada',
        avatar_url: null,
        text: 'Captured at the right moment',
        start_seconds: 4.25,
        end_seconds: 5.5,
      }],
    };
    const app = await import('./main.js');
    app.renderSessionSelects(null, [{
      session_id: 'past-session',
      channel_name: 'Planning',
      utterance_count: 1,
    }]);
    fetch.mockResolvedValueOnce({ ok: true, json: async () => detail });

    const select = document.getElementById('sessionSelect');
    select.value = 'past-session';
    select.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      expect(document.querySelector('.play-from-here')).not.toBeNull();
    });
    const clipButton = document.querySelector('.play-clip');
    const recording = document.getElementById('sessionRecording');
    expect(document.getElementById('recordingHeading')).toBeNull();
    expect(recording.controls).toBe(false);
    expect(recording.classList.contains('recording-transport')).toBe(true);
    expect(clipButton.closest('.transcript-leading')).not.toBeNull();
    expect(clipButton.textContent).toBe('Play clip');
    expect(clipButton.getAttribute('aria-label')).toBe('Play audio clip for Ada');
    expect(clipButton.disabled).toBe(false);
    expect(recording.hidden).toBe(false);
    expect(recording.src).toBe('http://localhost:8000/v1/sessions/past-session/audio');
    expect(document.getElementById('recordingStatus').textContent)
      .toBe('Full session recording available.');

    recording.dispatchEvent(new Event('loadedmetadata'));
    app.handleEvent({
      type: 'transcript',
      session_id: 'active-session',
      utterance_id: 'live-u1',
      speaker_name: 'Grace',
      text: 'Unrelated live line',
      finalized: false,
      start_seconds: 20,
      end_seconds: 21,
    });
    expect(recording.src).toBe('http://localhost:8000/v1/sessions/past-session/audio');
    clipButton.click();

    expect(recording.currentTime).toBe(4.25);
    expect(play).toHaveBeenCalledOnce();
    expect(clipButton.textContent).toBe('Playing');
    recording.currentTime = 5.49;
    recording.dispatchEvent(new Event('timeupdate'));
    expect(pause).not.toHaveBeenCalled();

    recording.currentTime = 5.51;
    recording.dispatchEvent(new Event('timeupdate'));

    expect(pause).toHaveBeenCalledOnce();
    expect(recording.currentTime).toBe(5.5);
    expect(clipButton.textContent).toBe('Replay clip');
    expect(clipButton.getAttribute('aria-pressed')).toBe('false');
  });

  it('streams growing active audio without replacing its source and resumes by offset', async () => {
    const mocks = installActiveAudioMocks();
    const app = await loadApp();
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    app.handleEvent({
      type: 'transcript',
      session_id: 'active-session',
      utterance_id: 'u1',
      speaker_name: 'Ada',
      text: 'Live captured line',
      finalized: true,
      start_seconds: 1.5,
      end_seconds: 2.0,
    });

    const recording = document.getElementById('sessionRecording');
    expect(recording.hidden).toBe(true);
    expect(recording.getAttribute('src')).toBeNull();
    expect(load).not.toHaveBeenCalled();
    const firstSocket = await makeActiveAudioAvailable(mocks, 'active-session', 2);
    expect(firstSocket.url)
      .toBe('ws://localhost:8000/v1/sessions/active-session/audio/stream');
    expect(firstSocket.sent).toEqual([
      { type: 'resume', offset: 0, revision: 0 },
      { type: 'ack', id: 1 },
    ]);
    recording.dispatchEvent(new Event('loadedmetadata'));
    recording.currentTime = 0.75;

    app.handleEvent({
      type: 'transcript',
      session_id: 'active-session',
      utterance_id: 'u2',
      speaker_name: 'Grace',
      text: 'Later live captured line',
      finalized: true,
      start_seconds: 8,
      end_seconds: 9,
    });

    expect(recording.getAttribute('src')).toBeNull();
    expect(mocks.sockets).toHaveLength(1);
    expect(load).not.toHaveBeenCalled();
    expect(recording.currentTime).toBe(0.75);
    firstSocket.serverMessage(JSON.stringify({
      type: 'chunk',
      id: 2,
      offset: 384000,
      size: 1344000,
      revision: 2,
    }));
    firstSocket.serverMessage(new ArrayBuffer(1344000));
    await vi.waitFor(() => {
      expect(recording.dataset.capturedThrough).toBe('9');
    });

    document.querySelectorAll('.play-from-here')[1].click();

    expect(recording.currentTime).toBe(8);
    expect(play).not.toHaveBeenCalled();
    expect(mocks.audioContexts[0].sources).toHaveLength(1);
    expect(mocks.audioContexts[0].sources[0].start).toHaveBeenCalledOnce();
    expect(document.getElementById('recordingStatus').textContent)
      .toContain('latest captured point');

    vi.useFakeTimers();
    firstSocket.close();
    vi.advanceTimersByTime(1000);
    const resumedSocket = mocks.sockets.at(-1);
    resumedSocket.open();
    expect(resumedSocket.sent).toEqual([{
      type: 'resume', offset: 1728000, revision: 2,
    }]);
    expect(recording.getAttribute('src')).toBeNull();
    resumedSocket.serverMessage(JSON.stringify({
      type: 'ready',
      session_id: 'active-session',
      offset: 1728000,
      captured_bytes: 1728000,
      revision: 2,
      reset: false,
      sample_rate: 48000,
      channels: 2,
      sample_width: 2,
    }));
    resumedSocket.serverMessage(JSON.stringify({
      type: 'complete',
      offset: 1728000,
      url: '/sessions/active-session/audio',
    }));
    await vi.waitFor(() => {
      expect(recording.src)
        .toBe('http://localhost:8000/v1/sessions/active-session/audio');
    });
    expect(mocks.audioContexts[0].close).toHaveBeenCalledOnce();
    expect(document.getElementById('recordingStatus').textContent)
      .toBe('Full session recording available.');
  });

  it('keeps live transcripts usable when Web Audio playback is unsupported', async () => {
    const app = await loadApp();

    app.handleEvent({
      type: 'transcript',
      session_id: 'active-session',
      utterance_id: 'u1',
      speaker_name: 'Ada',
      text: 'Transcript remains available',
      finalized: true,
      start_seconds: 1,
      end_seconds: 2,
    });

    expect(document.getElementById('transcriptList').textContent)
      .toContain('Transcript remains available');
    expect(document.getElementById('sessionRecording').getAttribute('src')).toBeNull();
    expect(document.getElementById('recordingStatus').textContent)
      .toBe('Live playback unavailable. Transcription remains active.');
    expect(document.getElementById('replayPlayBtn').disabled).toBe(false);
    expect(document.querySelector('.play-clip').disabled).toBe(true);
  });

  it('replaces mixed PCM ranges and rebuilds stale reconnect state', async () => {
    const mocks = installActiveAudioMocks();
    const app = await loadApp();
    const frames = 4;
    app.handleEvent({
      type: 'transcript',
      session_id: 'active-session',
      utterance_id: 'u1',
      speaker_name: 'Ada',
      text: 'Overlapping speakers',
      finalized: true,
      start_seconds: 0,
      end_seconds: frames / 48000,
    });

    const socket = mocks.sockets[0];
    socket.open();
    socket.serverMessage(JSON.stringify({
      type: 'ready',
      session_id: 'active-session',
      offset: 0,
      captured_bytes: frames * 4,
      revision: 1,
      reset: false,
      sample_rate: 48000,
      channels: 2,
      sample_width: 2,
    }));
    const first = new Int16Array(frames * 2).fill(1000);
    socket.serverMessage(JSON.stringify({
      type: 'chunk', id: 1, offset: 0, size: first.byteLength, revision: 1,
    }));
    socket.serverMessage(first.buffer);
    await vi.waitFor(() => {
      expect(socket.sent.at(-1)).toEqual({ type: 'ack', id: 1 });
    });

    const mixed = new Int16Array(frames * 2).fill(3000);
    socket.serverMessage(JSON.stringify({
      type: 'chunk', id: 2, offset: 0, size: mixed.byteLength, revision: 2,
    }));
    socket.serverMessage(mixed.buffer);
    await vi.waitFor(() => {
      expect(socket.sent.at(-1)).toEqual({ type: 'ack', id: 2 });
    });
    document.querySelector('.play-from-here').click();
    const mixedSource = mocks.audioContexts[0].sources.at(-1);
    expect(Array.from(mixedSource.buffer.getChannelData(0)))
      .toEqual(Array(frames).fill(3000 / 32768));

    vi.useFakeTimers();
    socket.close();
    vi.advanceTimersByTime(1000);
    const resumedSocket = mocks.sockets.at(-1);
    resumedSocket.open();
    expect(resumedSocket.sent).toEqual([{
      type: 'resume', offset: mixed.byteLength, revision: 2,
    }]);
    resumedSocket.serverMessage(JSON.stringify({
      type: 'ready',
      session_id: 'active-session',
      offset: 0,
      captured_bytes: frames * 4,
      revision: 3,
      reset: true,
      sample_rate: 48000,
      channels: 2,
      sample_width: 2,
    }));
    const durable = new Int16Array(frames * 2).fill(4000);
    resumedSocket.serverMessage(JSON.stringify({
      type: 'chunk', id: 1, offset: 0, size: durable.byteLength, revision: 3,
    }));
    resumedSocket.serverMessage(durable.buffer);
    await vi.waitFor(() => {
      expect(resumedSocket.sent.at(-1)).toEqual({ type: 'ack', id: 1 });
    });

    const recoveredSource = mocks.audioContexts[0].sources.at(-1);
    expect(Array.from(recoveredSource.buffer.getChannelData(0)))
      .toEqual(Array(frames).fill(4000 / 32768));
    expect(Number(document.getElementById('sessionRecording').dataset.capturedThrough))
      .toBe(frames / 48000);
  });

  it('stores long sessions in ranges and decodes bounded playback windows', async () => {
    const mocks = installActiveAudioMocks();
    const app = await loadApp();
    const durationSeconds = 12;
    const totalBytes = durationSeconds * 48000 * 4;
    app.handleEvent({
      type: 'transcript',
      session_id: 'active-session',
      utterance_id: 'u1',
      speaker_name: 'Ada',
      text: 'Long active session',
      finalized: true,
      start_seconds: 0,
      end_seconds: durationSeconds,
    });

    const socket = mocks.sockets[0];
    socket.open();
    socket.serverMessage(JSON.stringify({
      type: 'ready',
      session_id: 'active-session',
      offset: 0,
      captured_bytes: totalBytes,
      revision: 1,
      reset: false,
      sample_rate: 48000,
      channels: 2,
      sample_width: 2,
    }));
    let offset = 0;
    let id = 1;
    while (offset < totalBytes) {
      const size = Math.min(64 * 1024, totalBytes - offset);
      socket.serverMessage(JSON.stringify({
        type: 'chunk', id, offset, size, revision: 1,
      }));
      socket.serverMessage(new ArrayBuffer(size));
      offset += size;
      id += 1;
    }
    await vi.waitFor(() => {
      expect(socket.sent.at(-1)).toEqual({ type: 'ack', id: id - 1 });
    });

    document.querySelector('.play-from-here').click();
    const context = mocks.audioContexts[0];
    expect(context.createdFrameCounts).toEqual([5 * 48000]);
    context.sources.at(-1).onended();
    expect(context.createdFrameCounts).toEqual([5 * 48000, 5 * 48000]);
    context.sources.at(-1).onended();
    expect(context.createdFrameCounts).toEqual([
      5 * 48000,
      5 * 48000,
      2 * 48000,
    ]);
    expect(Math.max(...context.createdFrameCounts)).toBeLessThan(12 * 48000);
  });

  it('replaces clip playback with another audio action', async () => {
    const mocks = installActiveAudioMocks();
    const app = await loadApp();
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    app.handleEvent({
      type: 'transcript',
      session_id: 'active-session',
      utterance_id: 'u1',
      speaker_name: 'Ada',
      text: 'First overlapping speaker',
      finalized: true,
      start_seconds: 1,
      end_seconds: 3,
    });
    app.handleEvent({
      type: 'transcript',
      session_id: 'active-session',
      utterance_id: 'u2',
      speaker_name: 'Grace',
      text: 'Second overlapping speaker',
      finalized: true,
      start_seconds: 2,
      end_seconds: 4,
    });

    const recording = document.getElementById('sessionRecording');
    await makeActiveAudioAvailable(mocks, 'active-session', 4);
    recording.dispatchEvent(new Event('loadedmetadata'));
    const clipButtons = document.querySelectorAll('.play-clip');
    const fullPlaybackActions = document.querySelectorAll('.play-from-here');
    clipButtons[0].click();
    expect(recording.currentTime).toBe(1);
    expect(clipButtons[0].textContent).toBe('Playing');

    fullPlaybackActions[1].click();
    expect(recording.currentTime).toBe(2);
    expect(clipButtons[0].textContent).toBe('Play clip');
    mocks.audioContexts[0].currentTime = 2;
    recording.dispatchEvent(new Event('timeupdate'));
    expect(pause).not.toHaveBeenCalled();

    clipButtons[1].click();
    mocks.audioContexts[0].currentTime = 4;
    recording.dispatchEvent(new Event('timeupdate'));
    expect(pause).not.toHaveBeenCalled();
    expect(mocks.audioContexts[0].sources.at(-1).stop).toHaveBeenCalledOnce();
    expect(clipButtons[1].textContent).toBe('Replay clip');
    expect(play).not.toHaveBeenCalled();
    expect(mocks.audioContexts[0].sources).toHaveLength(3);
  });

  it.each(['active', 'closed', 'interrupted'])(
    'keeps uncaptured intervals unavailable for partial %s recordings',
    async (sessionStatus) => {
      const app = await loadApp();
      vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
      const detail = {
        session: { session_id: 'partial-session', status: sessionStatus },
        recording: {
          available: true,
          url: '/sessions/partial-session/audio',
          duration_seconds: 3,
        },
        transcripts: [
          {
            utterance_id: 'captured',
            speaker_name: 'Ada',
            text: 'Captured and playable',
            start_seconds: 1,
            end_seconds: 2,
          },
          {
            utterance_id: 'uncaptured',
            speaker_name: 'Grace',
            text: 'Readable beyond partial audio',
            start_seconds: 3,
            end_seconds: 4,
          },
        ],
      };
      app.renderSessionSelects(null, [{
        session_id: 'partial-session',
        channel_name: 'Partial',
        utterance_count: 2,
      }]);
      fetch.mockResolvedValueOnce({ ok: true, json: async () => detail });

      const select = document.getElementById('sessionSelect');
      select.value = 'partial-session';
      select.dispatchEvent(new Event('change'));

      await vi.waitFor(() => {
        expect(document.querySelectorAll('.play-clip')).toHaveLength(2);
      });
      const recording = document.getElementById('sessionRecording');
      const clipButtons = document.querySelectorAll('.play-clip');
      expect(recording.hidden).toBe(false);
      expect(recording.dataset.capturedThrough).toBe('3');
      expect(document.getElementById('replaySeek').max).toBe('3');
      expect(clipButtons[0].disabled).toBe(false);
      expect(clipButtons[0].textContent).toBe('Play clip');
      expect(clipButtons[1].disabled).toBe(true);
      expect(clipButtons[1].textContent).toBe('Unavailable');
      expect(document.getElementById('transcriptList').textContent)
        .toContain('Readable beyond partial audio');
    },
  );

  it('clears clip bounds for native seeks but retains them for clip seeks', async () => {
    const mocks = installActiveAudioMocks();
    const app = await loadApp();
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    app.handleEvent({
      type: 'transcript',
      session_id: 'active-session',
      utterance_id: 'u1',
      speaker_name: 'Ada',
      text: 'Bounded clip',
      finalized: true,
      start_seconds: 1,
      end_seconds: 3,
    });

    const recording = document.getElementById('sessionRecording');
    const clipButton = document.querySelector('.play-clip');
    await makeActiveAudioAvailable(mocks, 'active-session', 3);
    recording.dispatchEvent(new Event('loadedmetadata'));
    clipButton.click();
    recording.dispatchEvent(new Event('seeking'));
    expect(clipButton.textContent).toBe('Playing');

    mocks.audioContexts[0].currentTime = 2;
    recording.dispatchEvent(new Event('timeupdate'));
    expect(pause).not.toHaveBeenCalled();
    expect(mocks.audioContexts[0].sources[0].stop).toHaveBeenCalledOnce();
    expect(clipButton.textContent).toBe('Replay clip');

    clipButton.click();
    recording.dispatchEvent(new Event('seeking'));
    recording.currentTime = 2;
    recording.dispatchEvent(new Event('seeking'));
    expect(clipButton.textContent).toBe('Play clip');

    mocks.audioContexts[0].currentTime = 2;
    recording.dispatchEvent(new Event('timeupdate'));
    expect(pause).not.toHaveBeenCalled();
    expect(mocks.audioContexts[0].sources[0].stop).toHaveBeenCalledOnce();
  });

  it('keeps unavailable and untimed transcript rows readable', async () => {
    const app = await loadApp();
    const detail = {
      session: { session_id: 'legacy-session', status: 'closed' },
      recording: { available: false },
      transcripts: [
        {
          utterance_id: 'timed',
          speaker_name: 'Ada',
          text: 'Readable timed transcript',
          start_seconds: 1,
          end_seconds: 2,
        },
        {
          utterance_id: 'legacy',
          speaker_name: 'Grace',
          text: 'Readable legacy transcript',
        },
      ],
    };
    app.renderSessionSelects(null, [{
      session_id: 'legacy-session',
      channel_name: 'Legacy',
      utterance_count: 2,
    }]);
    fetch.mockResolvedValueOnce({ ok: true, json: async () => detail });

    const select = document.getElementById('sessionSelect');
    select.value = 'legacy-session';
    select.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      expect(document.querySelectorAll('.play-clip')).toHaveLength(2);
    });
    const clipButtons = document.querySelectorAll('.play-clip');
    expect(Array.from(clipButtons).every((button) => button.disabled)).toBe(true);
    expect(Array.from(clipButtons).every((button) => button.textContent === 'Unavailable'))
      .toBe(true);
    expect(document.getElementById('transcriptList').textContent)
      .toContain('Readable timed transcript');
    expect(document.getElementById('transcriptList').textContent)
      .toContain('Readable legacy transcript');
    expect(document.getElementById('recordingStatus').textContent)
      .toBe('Playback unavailable for this session.');
    expect(document.getElementById('errorMessage').hidden).toBe(true);
  });

  it('keeps playback failures separate from Discord controls', async () => {
    const app = await loadApp();
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const statusText = document.getElementById('statusText');
    const toggle = document.getElementById('toggleBtn');
    statusText.textContent = 'Bot ready';
    toggle.disabled = false;
    app.handleEvent({
      type: 'transcript',
      session_id: 'active-session',
      utterance_id: 'u1',
      speaker_name: 'Ada',
      text: 'Live captured line',
      finalized: true,
      start_seconds: 1.5,
      end_seconds: 2.0,
    });

    document.getElementById('sessionRecording').dispatchEvent(new Event('error'));

    expect(document.getElementById('recordingStatus').textContent)
      .toBe('Playback unavailable for this session.');
    expect(document.getElementById('errorMessage').hidden).toBe(true);
    expect(statusText.textContent).toBe('Bot ready');
    expect(toggle.disabled).toBe(false);
  });

  it('uses recording playback as the transcript clock in both directions', async () => {
    const app = await loadApp();
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const detail = {
      session: { session_id: 'synced-session', status: 'closed' },
      recording: {
        available: true,
        url: '/sessions/synced-session/audio',
        duration_seconds: 7,
      },
      transcripts: [
        {
          utterance_id: 'u1',
          speaker_name: 'Ada',
          text: 'First speaker',
          start_seconds: 1,
          end_seconds: 3,
        },
        {
          utterance_id: 'u2',
          speaker_name: 'Grace',
          text: 'Overlapping speaker',
          start_seconds: 2,
          end_seconds: 4,
        },
        {
          utterance_id: 'u3',
          speaker_name: 'Linus',
          text: 'After the gap',
          start_seconds: 6,
          end_seconds: 7,
        },
      ],
    };
    app.renderSessionSelects(null, [{
      session_id: 'synced-session',
      channel_name: 'Synchronized',
      utterance_count: 3,
    }]);
    fetch.mockResolvedValueOnce({ ok: true, json: async () => detail });
    const select = document.getElementById('sessionSelect');
    select.value = 'synced-session';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.transcript-entry')).toHaveLength(3);
    });

    const recording = document.getElementById('sessionRecording');
    const rows = Array.from(document.querySelectorAll('.transcript-entry'));
    const panel = document.getElementById('transcriptionPanel');
    Object.defineProperty(panel, 'clientHeight', { configurable: true, value: 100 });
    for (const [index, row] of rows.entries()) {
      Object.defineProperty(row, 'offsetTop', {
        configurable: true,
        value: 150 + index * 30,
      });
      Object.defineProperty(row, 'offsetHeight', { configurable: true, value: 30 });
    }
    const replayPlay = document.getElementById('replayPlayBtn');
    const replayPause = document.getElementById('replayPauseBtn');
    const replayRestart = document.getElementById('replayRestartBtn');
    const replaySeek = document.getElementById('replaySeek');
    recording.dispatchEvent(new Event('loadedmetadata'));

    replayPlay.click();
    expect(play).toHaveBeenCalledOnce();
    expect(recording.currentTime).toBe(0);
    expect(rows.every((row) => row.hidden)).toBe(true);
    expect(document.getElementById('replayStatus').textContent)
      .toBe('Playing recording and transcript on one timeline.');

    recording.currentTime = 2.5;
    recording.dispatchEvent(new Event('timeupdate'));
    expect(rows.map((row) => row.hidden)).toEqual([false, false, true]);
    expect(document.querySelectorAll('.replay-active')).toHaveLength(2);
    expect(replaySeek.value).toBe('2.5');
    expect(panel.scrollTop).toBe(110);

    recording.currentTime = 0.5;
    recording.dispatchEvent(new Event('seeking'));
    expect(rows.every((row) => row.hidden)).toBe(true);
    expect(document.querySelectorAll('.replay-active')).toHaveLength(0);

    recording.currentTime = 5;
    recording.dispatchEvent(new Event('seeking'));
    expect(rows.map((row) => row.hidden)).toEqual([false, false, true]);
    expect(document.querySelectorAll('.replay-active')).toHaveLength(0);

    recording.dispatchEvent(new Event('pause'));
    expect(replayPlay.disabled).toBe(false);
    expect(replayPause.disabled).toBe(true);
    expect(document.getElementById('replayStatus').textContent)
      .toBe('Recording and transcript replay paused.');

    recording.currentTime = 6.5;
    recording.dispatchEvent(new Event('seeking'));
    expect(rows.map((row) => row.hidden)).toEqual([false, false, false]);
    expect(rows[2].classList.contains('replay-active')).toBe(true);

    replayRestart.click();
    expect(recording.currentTime).toBe(0);
    expect(play).toHaveBeenCalledTimes(2);
    expect(rows.every((row) => row.hidden)).toBe(true);

    replaySeek.value = '3.5';
    replaySeek.dispatchEvent(new Event('input'));
    expect(recording.currentTime).toBe(3.5);
    expect(pause).toHaveBeenCalled();
    expect(rows.map((row) => row.hidden)).toEqual([false, false, true]);
    expect(document.querySelector('.replay-active .speaker-name').textContent)
      .toBe('Grace');

    recording.currentTime = 7;
    recording.dispatchEvent(new Event('ended'));
    expect(rows.every((row) => !row.hidden)).toBe(true);
    expect(document.getElementById('replayStatus').textContent)
      .toBe('Recording and transcript replay finished.');

    replayPlay.click();
    document.getElementById('clearBtn').click();
    expect(recording.currentTime).toBe(0);
    expect(document.getElementById('replayPlayBtn').disabled).toBe(true);
    expect(document.querySelectorAll('.transcript-entry')).toHaveLength(0);
  });

  it('keeps synchronized replay active through trailing recording audio', async () => {
    const app = await loadApp();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const detail = {
      session: { session_id: 'trailing-audio', status: 'closed' },
      recording: {
        available: true,
        url: '/sessions/trailing-audio/audio',
        duration_seconds: 10,
      },
      transcripts: [{
        utterance_id: 'u1',
        speaker_name: 'Ada',
        text: 'Transcript ends before recording',
        start_seconds: 1,
        end_seconds: 3,
      }],
    };
    app.renderSessionSelects(null, [{
      session_id: 'trailing-audio',
      channel_name: 'Trailing audio',
      utterance_count: 1,
    }]);
    fetch.mockResolvedValueOnce({ ok: true, json: async () => detail });
    const select = document.getElementById('sessionSelect');
    select.value = 'trailing-audio';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(document.querySelector('.transcript-entry')).not.toBeNull();
    });

    const recording = document.getElementById('sessionRecording');
    recording.dispatchEvent(new Event('loadedmetadata'));
    document.getElementById('replayPlayBtn').click();
    expect(document.getElementById('replaySeek').max).toBe('10');
    expect(document.getElementById('replayTime').textContent).toBe('0:00 / 0:10');

    recording.currentTime = 3;
    recording.dispatchEvent(new Event('timeupdate'));
    expect(pause).not.toHaveBeenCalled();
    expect(document.getElementById('replayStatus').textContent)
      .toBe('Playing recording and transcript on one timeline.');
    expect(document.getElementById('replayTime').textContent).toBe('0:03 / 0:10');
    expect(document.querySelectorAll('.replay-active')).toHaveLength(0);

    recording.currentTime = 10;
    recording.dispatchEvent(new Event('ended'));
    expect(document.getElementById('replayStatus').textContent)
      .toBe('Recording and transcript replay finished.');
    expect(document.getElementById('replayTime').textContent).toBe('0:10 / 0:10');
  });

  it('clears stale recording audio while a session loads and after load failure', async () => {
    const app = await loadApp();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const firstDetail = {
      session: { session_id: 'first-session', status: 'closed' },
      recording: {
        available: true,
        url: '/sessions/first-session/audio',
        duration_seconds: 4,
      },
      transcripts: [{
        utterance_id: 'u1',
        speaker_name: 'Ada',
        text: 'First session transcript',
        start_seconds: 0,
        end_seconds: 4,
      }],
    };
    app.renderSessionSelects(null, [
      { session_id: 'first-session', channel_name: 'First', utterance_count: 1 },
      { session_id: 'failed-session', channel_name: 'Failed', utterance_count: 1 },
    ]);
    fetch.mockResolvedValueOnce({ ok: true, json: async () => firstDetail });
    const select = document.getElementById('sessionSelect');
    select.value = 'first-session';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(document.getElementById('sessionRecording').hidden).toBe(false);
    });

    let resolveFailedLoad;
    fetch.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFailedLoad = resolve;
    }));
    select.value = 'failed-session';
    select.dispatchEvent(new Event('change'));

    const recording = document.getElementById('sessionRecording');
    expect(recording.hidden).toBe(true);
    expect(recording.getAttribute('src')).toBeNull();
    expect(recording.dataset.sessionId).toBeUndefined();
    expect(document.getElementById('replayPlayBtn').disabled).toBe(true);
    expect(document.getElementById('recordingStatus').textContent)
      .toBe('Playback unavailable for this session.');

    resolveFailedLoad({
      ok: false,
      status: 503,
      json: async () => ({ detail: 'Session detail unavailable' }),
    });
    await vi.waitFor(() => {
      expect(document.getElementById('errorMessage').textContent)
        .toBe('Could not load session transcript: Session detail unavailable');
    });
    expect(recording.hidden).toBe(true);
    expect(recording.getAttribute('src')).toBeNull();
    expect(recording.dataset.sessionId).toBeUndefined();
  });

  it('plays one bounded clip without hiding later transcript rows', async () => {
    const mocks = installActiveAudioMocks();
    const app = await loadApp();
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    app.handleEvent({
      type: 'transcript',
      session_id: 'active-session',
      utterance_id: 'u1',
      speaker_name: 'Ada',
      text: 'Bounded synchronized clip',
      finalized: true,
      start_seconds: 1,
      end_seconds: 3,
    });
    app.handleEvent({
      type: 'transcript',
      session_id: 'active-session',
      utterance_id: 'u2',
      speaker_name: 'Grace',
      text: 'Later transcript remains visible',
      finalized: true,
      start_seconds: 4,
      end_seconds: 5,
    });

    const recording = document.getElementById('sessionRecording');
    const rows = Array.from(document.querySelectorAll('.transcript-entry'));
    const clip = document.querySelectorAll('.play-clip')[0];
    await makeActiveAudioAvailable(mocks, 'active-session', 5);
    recording.dispatchEvent(new Event('loadedmetadata'));
    clip.click();

    expect(recording.currentTime).toBe(1);
    expect(rows.every((row) => !row.hidden)).toBe(true);
    expect(document.querySelectorAll('.replay-active')).toHaveLength(0);
    expect(document.getElementById('replayPlayBtn').disabled).toBe(false);

    recording.currentTime = 2.25;
    recording.dispatchEvent(new Event('timeupdate'));
    expect(rows.every((row) => !row.hidden)).toBe(true);
    expect(document.querySelectorAll('.replay-active')).toHaveLength(0);

    mocks.audioContexts[0].currentTime = 2;
    recording.dispatchEvent(new Event('timeupdate'));
    expect(pause).not.toHaveBeenCalled();
    expect(mocks.audioContexts[0].sources.at(-1).stop).toHaveBeenCalledOnce();
    expect(recording.currentTime).toBe(3);
    expect(clip.textContent).toBe('Replay clip');
    recording.dispatchEvent(new Event('seeking'));
    recording.dispatchEvent(new Event('pause'));
    expect(rows.every((row) => !row.hidden)).toBe(true);
    expect(document.querySelectorAll('.replay-active')).toHaveLength(0);
    expect(document.getElementById('replayTime').textContent).toBe('0:03 / 0:05');
    expect(document.getElementById('replayStatus').textContent)
      .toBe('Ready to play recording and transcript together.');
  });

  it('continues as visual-only replay when synchronized playback is rejected', async () => {
    const app = await loadApp();
    vi.spyOn(HTMLMediaElement.prototype, 'play')
      .mockRejectedValue(new Error('Unsupported audio'));
    const detail = {
      session: { session_id: 'fallback-session', status: 'closed' },
      recording: {
        available: true,
        url: '/sessions/fallback-session/audio',
        duration_seconds: 3,
      },
      transcripts: [{
        utterance_id: 'u1',
        speaker_name: 'Ada',
        text: 'Visual fallback remains available',
        start_seconds: 1,
        end_seconds: 3,
      }],
    };
    app.renderSessionSelects(null, [{
      session_id: 'fallback-session',
      channel_name: 'Fallback',
      utterance_count: 1,
    }]);
    fetch.mockResolvedValueOnce({ ok: true, json: async () => detail });
    const select = document.getElementById('sessionSelect');
    select.value = 'fallback-session';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(document.querySelector('.transcript-entry')).not.toBeNull();
    });
    const recording = document.getElementById('sessionRecording');
    recording.dispatchEvent(new Event('loadedmetadata'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T00:00:00Z'));

    document.getElementById('replayPlayBtn').click();
    await Promise.resolve();
    await Promise.resolve();

    expect(recording.hidden).toBe(true);
    expect(document.getElementById('recordingStatus').textContent)
      .toBe('Playback unavailable for this session.');
    expect(document.getElementById('replayStatus').textContent)
      .toBe('Audio unavailable. Playing visual-only transcript at original timing.');
    vi.advanceTimersByTime(1000);
    expect(document.querySelector('.transcript-entry').classList.contains('replay-active'))
      .toBe(true);
  });
});

describe('visual transcript replay', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('preserves gaps, highlights overlaps, scrolls them together, and stops at the final block', async () => {
    const app = await loadApp();
    await showSavedTranscript(app, [
      {
        utterance_id: 'u1',
        speaker_name: 'Ada',
        text: 'First speaker',
        start_seconds: 1,
        end_seconds: 3,
      },
      {
        utterance_id: 'u2',
        speaker_name: 'Grace',
        text: 'Overlapping speaker',
        start_seconds: 2,
        end_seconds: 4,
      },
      {
        utterance_id: 'u3',
        speaker_name: 'Linus',
        text: 'After a real pause',
        start_seconds: 6,
        end_seconds: 7,
      },
    ]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T00:00:00Z'));

    const panel = document.getElementById('transcriptionPanel');
    const rows = Array.from(document.querySelectorAll('.transcript-entry'));
    Object.defineProperty(panel, 'clientHeight', { configurable: true, value: 100 });
    for (const [index, row] of rows.entries()) {
      Object.defineProperty(row, 'offsetTop', {
        configurable: true,
        value: 150 + index * 30,
      });
      Object.defineProperty(row, 'offsetHeight', { configurable: true, value: 30 });
    }

    const play = document.getElementById('replayPlayBtn');
    const pause = document.getElementById('replayPauseBtn');
    const restart = document.getElementById('replayRestartBtn');
    expect(play.disabled).toBe(false);
    expect(pause.disabled).toBe(true);
    expect(restart.disabled).toBe(false);
    expect(rows.every((row) => !row.hidden)).toBe(true);

    play.click();
    expect(document.querySelectorAll('.replay-active')).toHaveLength(0);
    expect(rows.every((row) => row.hidden)).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(rows[0].classList.contains('replay-active')).toBe(true);
    expect(rows.map((row) => row.hidden)).toEqual([false, true, true]);
    expect(panel.scrollTop).toBe(80);

    vi.advanceTimersByTime(1000);
    expect(document.querySelectorAll('.replay-active')).toHaveLength(2);
    expect(rows.map((row) => row.hidden)).toEqual([false, false, true]);
    expect(rows[0].getAttribute('aria-current')).toBe('true');
    expect(rows[1].getAttribute('aria-current')).toBe('true');
    expect(panel.scrollTop).toBe(110);

    vi.advanceTimersByTime(2000);
    expect(document.querySelectorAll('.replay-active')).toHaveLength(0);
    expect(rows.map((row) => row.hidden)).toEqual([false, false, true]);
    expect(document.getElementById('replayStatus').textContent)
      .toBe('Audio unavailable. Playing visual-only transcript at original timing.');

    vi.advanceTimersByTime(2000);
    expect(rows[2].classList.contains('replay-active')).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(document.querySelectorAll('.replay-active')).toHaveLength(0);
    expect(document.getElementById('replayStatus').textContent)
      .toBe('Audio unavailable. Visual-only transcript replay finished.');
    expect(rows.every((row) => !row.hidden)).toBe(true);
    expect(play.disabled).toBe(false);
    expect(pause.disabled).toBe(true);
  });

  it('pauses the clock and restarts safely from the beginning', async () => {
    const app = await loadApp();
    await showSavedTranscript(app, [{
      utterance_id: 'u1',
      speaker_name: 'Ada',
      text: 'Timed block',
      start_seconds: 0.5,
      end_seconds: 2,
    }]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T00:00:00Z'));

    const play = document.getElementById('replayPlayBtn');
    const pause = document.getElementById('replayPauseBtn');
    const restart = document.getElementById('replayRestartBtn');
    play.click();
    vi.advanceTimersByTime(750);
    expect(document.querySelector('.transcript-entry').classList.contains('replay-active'))
      .toBe(true);

    pause.click();
    expect(play.disabled).toBe(false);
    expect(pause.disabled).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(document.querySelector('.transcript-entry').classList.contains('replay-active'))
      .toBe(true);
    expect(document.querySelector('.transcript-entry').hidden).toBe(false);

    restart.click();
    expect(document.querySelectorAll('.replay-active')).toHaveLength(0);
    expect(play.disabled).toBe(true);
    expect(pause.disabled).toBe(false);
    expect(document.querySelector('.transcript-entry').hidden).toBe(true);
    vi.advanceTimersByTime(500);
    expect(document.querySelector('.transcript-entry').classList.contains('replay-active'))
      .toBe(true);
  });

  it('extends a playing active-session limit when later timed content arrives', async () => {
    const app = await loadApp();
    app.handleEvent({
      type: 'transcript',
      utterance_id: 'u1',
      speaker_name: 'Ada',
      text: 'Current live line',
      finalized: false,
      start_seconds: 1,
      end_seconds: 2,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T00:00:00Z'));

    document.getElementById('replayPlayBtn').click();
    vi.advanceTimersByTime(1500);
    expect(document.querySelector('.transcript-entry').classList.contains('replay-active'))
      .toBe(true);

    app.handleEvent({
      type: 'transcript',
      utterance_id: 'u2',
      speaker_name: 'Grace',
      text: 'Later live line',
      finalized: false,
      start_seconds: 3,
      end_seconds: 4,
    });
    vi.advanceTimersByTime(500);
    expect(document.getElementById('replayStatus').textContent)
      .toBe('Audio unavailable. Playing visual-only transcript at original timing.');
    expect(document.querySelectorAll('.replay-active')).toHaveLength(0);
    expect(Array.from(document.querySelectorAll('.transcript-entry')).map(
      (row) => row.hidden,
    )).toEqual([false, true]);
    vi.advanceTimersByTime(1000);
    expect(document.querySelectorAll('.replay-active')).toHaveLength(1);
    expect(document.querySelector('.replay-active .speaker-name').textContent).toBe('Grace');
    vi.advanceTimersByTime(1000);
    expect(document.getElementById('replayStatus').textContent)
      .toBe('Audio unavailable. Visual-only transcript replay finished.');
  });

  it('recomputes revealed and active rows after backward and forward seeking', async () => {
    const app = await loadApp();
    await showSavedTranscript(app, [
      {
        utterance_id: 'u1',
        speaker_name: 'Ada',
        text: 'Completed before the overlap',
        start_seconds: 1,
        end_seconds: 2,
      },
      {
        utterance_id: 'u2',
        speaker_name: 'Grace',
        text: 'First active speaker',
        start_seconds: 3,
        end_seconds: 5,
      },
      {
        utterance_id: 'u3',
        speaker_name: 'Linus',
        text: 'Second active speaker',
        start_seconds: 4,
        end_seconds: 6,
      },
    ]);
    const rows = Array.from(document.querySelectorAll('.transcript-entry'));
    const seek = document.getElementById('replaySeek');
    expect(rows.every((row) => !row.hidden)).toBe(true);

    seek.value = '4.5';
    seek.dispatchEvent(new Event('input'));
    expect(rows.map((row) => row.hidden)).toEqual([false, false, false]);
    expect(document.querySelectorAll('.replay-active')).toHaveLength(2);
    expect(document.getElementById('replayStatus').textContent)
      .toBe('Audio unavailable. Visual-only transcript replay paused.');

    seek.value = '0.5';
    seek.dispatchEvent(new Event('input'));
    expect(rows.every((row) => row.hidden)).toBe(true);
    expect(document.querySelectorAll('.replay-active')).toHaveLength(0);

    seek.value = '3.5';
    seek.dispatchEvent(new Event('input'));
    expect(rows.map((row) => row.hidden)).toEqual([false, false, true]);
    expect(document.querySelector('.replay-active .speaker-name').textContent)
      .toBe('Grace');

    seek.value = '6';
    seek.dispatchEvent(new Event('input'));
    expect(rows.every((row) => !row.hidden)).toBe(true);
    expect(document.querySelectorAll('.replay-active')).toHaveLength(0);
    expect(document.getElementById('replayStatus').textContent)
      .toBe('Audio unavailable. Visual-only transcript replay finished.');
  });

  it('resets immediately when output is cleared or another session is selected', async () => {
    const app = await loadApp();
    await showSavedTranscript(app, [{
      utterance_id: 'u1',
      speaker_name: 'Ada',
      text: 'Current session',
      start_seconds: 0,
      end_seconds: 5,
    }]);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T00:00:00Z'));

    document.getElementById('replayPlayBtn').click();
    expect(document.querySelectorAll('.replay-active')).toHaveLength(1);
    document.getElementById('clearBtn').click();
    expect(document.getElementById('replayPlayBtn').disabled).toBe(true);
    expect(document.querySelectorAll('.replay-active')).toHaveLength(0);
    vi.advanceTimersByTime(5000);
    expect(document.getElementById('replayStatus').textContent)
      .toBe('Transcript replay unavailable for this session.');

    const select = document.getElementById('sessionSelect');
    select.value = 'active';
    select.dispatchEvent(new Event('change'));
    app.handleEvent({
      type: 'transcript',
      utterance_id: 'live',
      speaker_name: 'Grace',
      text: 'New live output',
      finalized: false,
      start_seconds: 0,
      end_seconds: 5,
    });
    document.getElementById('replayPlayBtn').click();
    expect(document.querySelectorAll('.replay-active')).toHaveLength(1);

    let resolveOtherSession;
    fetch.mockImplementationOnce(() => new Promise((resolve) => {
      resolveOtherSession = resolve;
    }));
    const option = document.createElement('option');
    option.value = 'other-session';
    option.textContent = 'Other session';
    select.appendChild(option);
    select.value = 'other-session';
    select.dispatchEvent(new Event('change'));
    expect(document.getElementById('replayPlayBtn').disabled).toBe(true);
    expect(document.querySelectorAll('.replay-active')).toHaveLength(0);

    document.getElementById('clearBtn').click();
    resolveOtherSession({
      ok: true,
      json: async () => ({
        session: { session_id: 'other-session', status: 'closed' },
        recording: { available: false },
        transcripts: [{
          utterance_id: 'stale',
          speaker_name: 'Linus',
          text: 'Stale response',
          start_seconds: 0,
          end_seconds: 2,
        }],
      }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelectorAll('.transcript-entry')).toHaveLength(0);
    expect(document.getElementById('replayPlayBtn').disabled).toBe(true);
  });

  it('keeps malformed transcript text readable and exposes replay as unavailable', async () => {
    const app = await loadApp();
    await showSavedTranscript(app, [
      {
        utterance_id: 'valid',
        speaker_name: 'Ada',
        text: 'Valid timing remains readable',
        start_seconds: 1,
        end_seconds: 2,
      },
      {
        utterance_id: 'malformed',
        speaker_name: 'Grace',
        text: 'Malformed timing remains readable',
        start_seconds: 4,
        end_seconds: 3,
      },
    ]);

    expect(document.getElementById('transcriptList').textContent)
      .toContain('Valid timing remains readable');
    expect(document.getElementById('transcriptList').textContent)
      .toContain('Malformed timing remains readable');
    expect(document.getElementById('replayPlayBtn').disabled).toBe(true);
    expect(document.getElementById('replayPauseBtn').disabled).toBe(true);
    expect(document.getElementById('replayRestartBtn').disabled).toBe(true);
    expect(document.getElementById('replayStatus').textContent)
      .toBe('Transcript replay unavailable for this session.');
    expect(Array.from(document.querySelectorAll('.transcript-entry')).every(
      (row) => !row.hidden,
    )).toBe(true);
  });
});

describe('safe report reading and history', () => {
  beforeEach(() => {
    window.attacked = false;
    vi.restoreAllMocks();
  });

  it('lists Discord metadata as inert text and reopens the selected saved report', async () => {
    const app = await loadApp();
    app.renderSavedReportsList([savedReport]);

    const item = document.querySelector('.saved-report-item');
    expect(item.textContent).toContain(savedReport.session_previews[0].channel_name);
    expect(item.textContent).toContain(savedReport.session_previews[0].guild_name);
    expect(item.querySelector('img')).toBeNull();
    expect(item.querySelector('script')).toBeNull();
    expect(window.attacked).toBe(false);

    fetch.mockResolvedValue({ ok: true, json: async () => savedReport });
    item.click();

    await vi.waitFor(() => {
      expect(document.querySelector('#reportContent h2').textContent).toBe('Summary');
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:8000/v1/reports/report-12345678',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(document.getElementById('reportDisplayContainer').hidden).toBe(false);
    expect(document.body.classList.contains('report-modal-open')).toBe(true);
    expect(document.activeElement).toBe(document.getElementById('closeReportBtn'));
    expect(item.getAttribute('aria-current')).toBe('true');

    await vi.waitFor(() => expect(item.disabled).toBe(false));
    document.getElementById('closeReportBtn').click();
    expect(document.getElementById('reportDisplayContainer').hidden).toBe(true);
    expect(document.body.classList.contains('report-modal-open')).toBe(false);
    expect(document.activeElement).toBe(item);
  });

  it('presents Markdown structure through safe DOM construction', async () => {
    const { renderReportMarkdown } = await loadApp();
    const container = document.getElementById('reportContent');
    renderReportMarkdown(container, savedReport.content);

    expect(container.querySelector('h2').textContent).toBe('Summary');
    expect(container.querySelectorAll('ul > li')).toHaveLength(2);
    expect(container.querySelector('strong').textContent).toBe('Decision:');
    expect(container.textContent).toContain('<img src=x onerror="window.attacked=true">');
    expect(container.textContent).toContain('<script>window.attacked=true</script>');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(window.attacked).toBe(false);
  });

  it('renders code, quotes, and empty reports as readable blocks', async () => {
    const { renderReportMarkdown } = await loadApp();
    const container = document.getElementById('reportContent');

    renderReportMarkdown(container, '> Local only\n\n```js\nconst safe = true;\n```');
    expect(container.querySelector('blockquote').textContent).toBe('Local only');
    expect(container.querySelector('pre code').textContent).toBe('const safe = true;');

    renderReportMarkdown(container, '');
    expect(container.textContent).toBe('This report has no content.');
  });
});

describe('report generation and errors', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('submits every checked session without affecting Discord controls', async () => {
    const app = await loadApp();
    app.renderSessionSelects(null, [
      { session_id: 'session-1', channel_name: 'One', utterance_count: 2 },
      { session_id: 'session-2', channel_name: 'Two', utterance_count: 3 },
    ]);
    const checkboxes = document.querySelectorAll('#reportSessionsSelect input');
    checkboxes[0].checked = true;
    checkboxes[1].checked = true;

    fetch.mockImplementation(async (url, options = {}) => {
      if (url.endsWith('/reports') && options.method === 'POST') {
        return { ok: true, json: async () => savedReport };
      }
      return { ok: true, json: async () => ({ reports: [] }) };
    });

    const languageSelect = document.getElementById('reportLanguageSelect');
    languageSelect.querySelector('.select-trigger').click();
    languageSelect.querySelector('[data-value="he"]').click();
    document.getElementById('generateReportBtn').click();

    await vi.waitFor(() => {
      expect(document.querySelector('#reportContent h2').textContent).toBe('Summary');
    });
    const postCall = fetch.mock.calls.find(([, options]) => options.method === 'POST');
    expect(JSON.parse(postCall[1].body)).toEqual({
      session_ids: ['session-1', 'session-2'],
      language: 'he',
    });
    expect(document.getElementById('generateReportBtn').getAttribute('aria-busy')).toBeNull();
  });

  it('shows empty selection feedback only in the report controls', async () => {
    await loadApp();
    const discordError = document.getElementById('errorMessage');
    discordError.textContent = 'Discord status remains here';
    discordError.hidden = false;

    document.getElementById('generateReportBtn').click();

    expect(document.getElementById('reportErrorMessage').textContent)
      .toBe('Please select at least one session to summarize.');
    expect(discordError.textContent).toBe('Discord status remains here');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps backend report failures scoped away from Discord status and controls', async () => {
    await loadApp();
    const group = document.getElementById('reportSessionsSelect');
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = 'session-1';
    checkbox.checked = true;
    label.appendChild(checkbox);
    group.replaceChildren(label);

    const statusText = document.getElementById('statusText');
    const toggle = document.getElementById('toggleBtn');
    statusText.textContent = 'Bot ready';
    toggle.disabled = false;
    fetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ detail: 'Report generation failed' }),
    });

    document.getElementById('generateReportBtn').click();

    await vi.waitFor(() => {
      expect(document.getElementById('reportErrorMessage').textContent)
        .toBe('Report generation failed');
    });
    expect(document.getElementById('errorMessage').hidden).toBe(true);
    expect(statusText.textContent).toBe('Bot ready');
    expect(toggle.disabled).toBe(false);
  });
});

describe('report exports', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('keeps public metadata and complete structured content in Markdown', async () => {
    const { buildReportExport } = await loadApp();
    const exported = buildReportExport(savedReport, 'md');

    expect(exported.filename).toBe('DTT_Report_report-1.md');
    expect(exported.mimeType).toBe('text/markdown');
    expect(exported.content).toContain('**Generated At:**');
    expect(exported.content).toContain('**Language:** en');
    expect(exported.content).not.toContain('legacy-private-model');
    expect(exported.content).not.toMatch(/model|provider/i);
    expect(exported.content).toContain(
      `**Source Sessions:** ${savedReport.session_previews[0].channel_name} (${savedReport.session_previews[0].guild_name})`,
    );
    expect(exported.content.endsWith(savedReport.content)).toBe(true);
  });

  it('removes presentation syntax without deleting report content characters', async () => {
    const { buildReportExport } = await loadApp();
    const report = {
      ...savedReport,
      content: [
        '## Findings',
        'Issue #123 remains **** and 2 * 3 is 6.',
        'Keep literal hash#tag and escaped \\*asterisks\\*.',
        '**Bold text** and `const mask = "****";`',
        '```js',
        'const code = "#123 * **** `tick`";',
        '```',
      ].join('\n'),
    };
    const exported = buildReportExport(report, 'txt');

    expect(exported.filename).toBe('DTT_Report_report-1.txt');
    expect(exported.content).toContain('Findings');
    expect(exported.content).not.toContain('## Findings');
    expect(exported.content).toContain('Issue #123 remains **** and 2 * 3 is 6.');
    expect(exported.content).toContain('Keep literal hash#tag and escaped *asterisks*.');
    expect(exported.content).toContain('Bold text and const mask = "****";');
    expect(exported.content).not.toContain('**Bold text**');
    expect(exported.content).toContain('const code = "#123 * **** `tick`";');
    expect(exported.content).not.toContain('```js');
    expect(exported.content).not.toContain('legacy-private-model');
    expect(exported.content).not.toMatch(/model|provider/i);
  });
});

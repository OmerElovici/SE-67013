// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const styles = readFileSync(resolve(process.cwd(), 'index.css'), 'utf8');
const body = page.match(/<body>([\s\S]*)<\/body>/)[1];

const savedReport = {
  report_id: 'report-12345678',
  created_at: '2026-07-31T10:00:00Z',
  language: 'en',
  model: 'qwen3:8b',
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

    await vi.waitFor(() => {
      expect(document.querySelector('#reportSessionsSelect input').value).toBe('active-session');
    });
    expect(document.querySelector('.session-check-name').textContent).toBe('Live - Standup');
    expect(document.getElementById('sessionStatus').textContent).toBe('1 available');
    expect(fetch).toHaveBeenCalledTimes(2);
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
    expect(item.getAttribute('aria-current')).toBe('true');
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

    document.getElementById('generateReportBtn').click();

    await vi.waitFor(() => {
      expect(document.querySelector('#reportContent h2').textContent).toBe('Summary');
    });
    const postCall = fetch.mock.calls.find(([, options]) => options.method === 'POST');
    expect(JSON.parse(postCall[1].body)).toEqual({
      session_ids: ['session-1', 'session-2'],
      language: 'en',
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
      json: async () => ({ detail: 'Ollama unavailable' }),
    });

    document.getElementById('generateReportBtn').click();

    await vi.waitFor(() => {
      expect(document.getElementById('reportErrorMessage').textContent).toBe('Ollama unavailable');
    });
    expect(document.getElementById('errorMessage').hidden).toBe(true);
    expect(statusText.textContent).toBe('Bot ready');
    expect(toggle.disabled).toBe(false);
  });
});

describe('report exports', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('keeps all metadata and the complete structured content in Markdown', async () => {
    const { buildReportExport } = await loadApp();
    const exported = buildReportExport(savedReport, 'md');

    expect(exported.filename).toBe('DTT_Report_report-1.md');
    expect(exported.mimeType).toBe('text/markdown');
    expect(exported.content).toContain('**Generated At:**');
    expect(exported.content).toContain('**Language:** en');
    expect(exported.content).toContain('**Model:** qwen3:8b');
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
  });
});

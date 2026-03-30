import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import App from './App.js';

const apiMocks = vi.hoisted(() => ({
  getAuthStatus: vi.fn(),
  verifyToken: vi.fn(),
  setStoredToken: vi.fn(),
  getStoredToken: vi.fn(),
  clearStoredToken: vi.fn(),
  getHealth: vi.fn(),
  setupAuthToken: vi.fn(),
  listRecordsV2: vi.fn(),
}));

vi.mock('./api/client.js', () => ({
  getAuthStatus: apiMocks.getAuthStatus,
  verifyToken: apiMocks.verifyToken,
  setStoredToken: apiMocks.setStoredToken,
  getStoredToken: apiMocks.getStoredToken,
  clearStoredToken: apiMocks.clearStoredToken,
  getHealth: apiMocks.getHealth,
  setupAuthToken: apiMocks.setupAuthToken,
  listRecordsV2: apiMocks.listRecordsV2,
}));

vi.mock('./pages/Stats.js', () => ({
  default: () => <div>Stats Page</div>,
}));
vi.mock('./pages/ReviewInbox.js', () => ({
  default: () => <div>Review Inbox Page</div>,
}));
vi.mock('./pages/MemoryBrowser.js', () => ({
  default: () => <div>Memory Browser Page</div>,
}));
vi.mock('./pages/RelationGraph.js', () => ({
  default: () => <div>Relation Graph Page</div>,
}));
vi.mock('./pages/LifecycleMonitor.js', () => ({
  default: () => <div>Lifecycle Page</div>,
}));
vi.mock('./pages/FeedbackReview.js', () => ({
  default: () => <div>Feedback Page</div>,
}));
vi.mock('./pages/Settings/index.js', () => ({
  default: () => <div>Settings Page</div>,
}));
vi.mock('./pages/Agents.js', () => ({
  default: () => <div>Agents Page</div>,
}));
vi.mock('./pages/AgentDetail.js', () => ({
  default: () => <div>Agent Detail Page</div>,
}));
vi.mock('./pages/ExtractionLogs.js', () => ({
  default: () => <div>Extraction Logs Page</div>,
}));
vi.mock('./pages/SystemLogs.js', () => ({
  default: () => <div>System Logs Page</div>,
}));
vi.mock('./pages/ImportExport.js', () => ({
  default: () => <div>Import Export Page</div>,
}));

describe('App routing', () => {
  beforeEach(() => {
    window.localStorage.setItem('cortex-locale', 'zh');
    window.history.pushState({}, '', '/');
    apiMocks.getAuthStatus.mockResolvedValue({
      authRequired: false,
      setupRequired: false,
    });
    apiMocks.verifyToken.mockResolvedValue({ valid: true });
    apiMocks.getStoredToken.mockReturnValue(null);
    apiMocks.getHealth.mockResolvedValue({
      version: '1.0.0',
      github: 'https://github.com/example/repo',
      latestRelease: null,
    });
    apiMocks.listRecordsV2.mockResolvedValue({ items: [] });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('defaults the root route to the review inbox', async () => {
    render(<App />);

    expect(await screen.findByText('Review Inbox Page')).toBeTruthy();
    expect(screen.queryByText('Stats Page')).toBeNull();
  });
});

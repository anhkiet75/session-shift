import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleMessage } from '../background.js';
import * as sessionStore from '../lib/session-store.js';

// Mock chrome global object
const mockDnr = {
  updateSessionRules: vi.fn().mockResolvedValue({}),
};
const mockStorageSession = {
  get: vi.fn().mockResolvedValue({}),
  set: vi.fn().mockResolvedValue({}),
};
const mockStorageLocal = {
  get: vi.fn().mockResolvedValue({}),
  remove: vi.fn().mockResolvedValue({}),
};

function setupChromeMock() {
  global.chrome = {
    runtime: {
      id: 'ext-id',
      onMessage: {
        addListener: vi.fn(),
      },
    },
    declarativeNetRequest: mockDnr,
    storage: {
      session: mockStorageSession,
      local: mockStorageLocal,
    },
    tabs: {
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      query: vi.fn(),
    },
    action: {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
    },
  };
}

setupChromeMock();

vi.mock('../lib/session-store.js', async () => {
  const actual = await vi.importActual('../lib/session-store.js');
  return {
    ...actual,
    getSessionList: vi.fn(),
    setSessionList: vi.fn(),
  };
});

describe('background.js - batch rename', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should update multiple session names across different origins', async () => {
    const mockSessions = [
      { id: 'session_1', origin: 'https://google.com', name: 'Google Work' },
      { id: 'session_2', origin: 'https://github.com', name: 'GitHub Personal' },
    ];

    const storageState = {
      'https://google.com': [{ id: 'session_1', name: 'Google Old' }],
      'https://github.com': [{ id: 'session_2', name: 'GitHub Old' }],
    };

    sessionStore.getSessionList.mockImplementation(async (origin) => storageState[origin] || []);
    sessionStore.setSessionList.mockImplementation(async (origin, list) => {
      storageState[origin] = list;
    });

    const request = {
      action: 'renameSessions',
      payload: { sessions: mockSessions },
    };

    const response = await handleMessage(request, { id: 'ext-id' });

    expect(response).toEqual({ success: true });
    expect(storageState['https://google.com'][0].name).toBe('Google Work');
    expect(storageState['https://github.com'][0].name).toBe('GitHub Personal');
    expect(sessionStore.setSessionList).toHaveBeenCalledTimes(2);
  });

  it('should return error for invalid payload', async () => {
    const request = {
      action: 'renameSessions',
      payload: { sessions: 'not-an-array' },
    };

    const response = await handleMessage(request, { id: 'ext-id' });

    expect(response).toEqual({ error: 'invalid payload' });
  });
});

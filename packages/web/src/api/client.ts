import type {
  ConfirmPayload,
  ControlPayload,
  DraftDto,
  EditProposal,
  LogPage,
  SettingsPayload,
  StateSnapshot,
  WorldLine,
} from '@wispiva/contract';

export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient(fetcher: typeof fetch = fetch, baseUrl = '/api') {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetcher(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...init?.headers,
      },
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `请求失败：${response.status}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  function post<T>(path: string, payload: unknown): Promise<T> {
    return request<T>(path, { method: 'POST', body: JSON.stringify(payload) });
  }

  return {
    getState: () => request<StateSnapshot>('/state'),
    getLog: (lineId: WorldLine['id'], options: { beforeRevisionId?: string; limit?: number } = {}) => {
      const query = new URLSearchParams();
      if (options.beforeRevisionId !== undefined) query.set('beforeRevisionId', options.beforeRevisionId);
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return request<LogPage>(`/lines/${encodeURIComponent(lineId)}/log${suffix}`);
    },
    control: (payload: ControlPayload) => post<WorldLine>('/control', payload),
    postDraft: (payload: Pick<ControlPayload, 'lineId'>) =>
      post<DraftDto>('/draft', { lineId: payload.lineId }),
    postEdit: (draft: Pick<DraftDto, 'id'>) => post<EditProposal>('/edit', { draftId: draft.id }),
    postConfirm: (payload: ConfirmPayload) => post<WorldLine>('/confirm', payload),
    postSettings: (payload: SettingsPayload) => post<void>('/settings', payload),
    eventsUrl: `${baseUrl}/events`,
  };
}

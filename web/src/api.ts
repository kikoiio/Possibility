// web/src/api.ts — 只读 API 访问层
export interface PublicEntry {
  id: string;
  ts: number;
  type: 'activity' | 'dialogue' | 'monologue' | 'mystery';
  residentIds: string[];
  location: string;
  title: string | null;
  content: string;
}

export interface PublicResident {
  id: string;
  name: string;
  age: number;
  role: string;
  description: string;
  personality: string;
  speechStyle: string;
  likes: string[];
  dialogueExamples: string[];
}

export interface TimelineResponse {
  entries: PublicEntry[];
  nextCursor: string | null;
}

export interface NowResponse {
  localTime: string;
  period: string;
  weather: string;
  season: string;
  residents: {
    id: string;
    name: string;
    location: string;
    activity: string;
    since: number | null;
  }[];
}

const BASE = '/api';

export async function fetchNow(): Promise<NowResponse> {
  const res = await fetch(`${BASE}/now`);
  if (!res.ok) throw new Error(`now ${res.status}`);
  return res.json() as Promise<NowResponse>;
}

export async function fetchTimeline(opts: {
  cursor?: string | undefined;
  resident?: string | undefined;
  limit?: number | undefined;
}): Promise<TimelineResponse> {
  const params = new URLSearchParams();
  params.set('limit', String(opts.limit ?? 20));
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.resident) params.set('resident', opts.resident);
  const res = await fetch(`${BASE}/timeline?${params}`);
  if (!res.ok) throw new Error(`timeline ${res.status}`);
  return res.json() as Promise<TimelineResponse>;
}

export async function fetchResidents(): Promise<{ residents: PublicResident[] }> {
  const res = await fetch(`${BASE}/residents`);
  if (!res.ok) throw new Error(`residents ${res.status}`);
  return res.json() as Promise<{ residents: PublicResident[] }>;
}

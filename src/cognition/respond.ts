// src/cognition/respond.ts — 二期会话接口（本期留壳，架构预留）
// 二期：api 会话路由调本接口；三期：语音管线复用同一入口。

import type { LlmContext } from '../llm/client';
import type { ResidentProfile } from '../persona/profile';

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Session {
  visitorId: string;
  messages: SessionMessage[];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function respond(
  _ctx: LlmContext,
  _resident: ResidentProfile,
  _session: Session,
): Promise<string> {
  throw new Error('NotImplemented：访客会话属二期，本期仅预留接口');
}

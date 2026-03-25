/**
 * Sinalização WebRTC em memória para compartilhamento de tela no Help Desk.
 * Um par offer/answer por ticket; ICE em filas. Não persiste em DB.
 */

export type ScreenShareSdp = { sdp: string; type: 'offer' | 'answer' | 'pranswer' };

/** JSON serializável do candidato ICE (browser WebRTC). */
export type IceCandidateJson = Record<string, unknown>;

export interface ScreenShareStateDto {
  offer: ScreenShareSdp | null;
  answer: ScreenShareSdp | null;
  iceFromOwner: IceCandidateJson[];
  iceFromStaff: IceCandidateJson[];
}

interface Session extends ScreenShareStateDto {
  updatedAt: number;
}

const sessions = new Map<string, Session>();

const MAX_ICE = 150;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function touch(s: Session) {
  s.updatedAt = Date.now();
}

function pruneOld() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

function getSession(ticketId: string): Session {
  let s = sessions.get(ticketId);
  if (!s) {
    s = {
      offer: null,
      answer: null,
      iceFromOwner: [],
      iceFromStaff: [],
      updatedAt: Date.now(),
    };
    sessions.set(ticketId, s);
  }
  return s;
}

export function getScreenShareState(ticketId: string): ScreenShareStateDto {
  pruneOld();
  const s = sessions.get(ticketId);
  if (!s) {
    return { offer: null, answer: null, iceFromOwner: [], iceFromStaff: [] };
  }
  return {
    offer: s.offer,
    answer: s.answer,
    iceFromOwner: [...s.iceFromOwner],
    iceFromStaff: [...s.iceFromStaff],
  };
}

export function postScreenShareSignal(
  ticketId: string,
  role: 'owner' | 'staff',
  body: unknown,
): { ok: true } | { ok: false; error: string } {
  pruneOld();
  const b = body as Record<string, unknown>;
  const action = typeof b?.action === 'string' ? b.action : '';

  if (action === 'reset') {
    if (role !== 'owner') {
      return { ok: false, error: 'Apenas o solicitante pode reiniciar a sessão' };
    }
    sessions.delete(ticketId);
    return { ok: true };
  }

  const s = getSession(ticketId);

  if (action === 'offer') {
    if (role !== 'owner') {
      return { ok: false, error: 'Apenas o solicitante envia a oferta' };
    }
    const sdp = typeof b.sdp === 'string' ? b.sdp : '';
    if (!sdp.trim()) {
      return { ok: false, error: 'SDP inválido' };
    }
    s.offer = { sdp, type: 'offer' };
    s.answer = null;
    s.iceFromOwner = [];
    s.iceFromStaff = [];
    touch(s);
    return { ok: true };
  }

  if (action === 'answer') {
    if (role !== 'staff') {
      return { ok: false, error: 'Apenas o atendente envia a resposta' };
    }
    const sdp = typeof b.sdp === 'string' ? b.sdp : '';
    const typ = b.type === 'answer' ? 'answer' : null;
    if (!sdp.trim() || !typ) {
      return { ok: false, error: 'SDP inválido' };
    }
    s.answer = { sdp, type: typ };
    touch(s);
    return { ok: true };
  }

  if (action === 'ice') {
    const from = b.from === 'owner' || b.from === 'staff' ? b.from : null;
    const candidate = b.candidate as IceCandidateJson | null | undefined;
    if (!from || candidate === undefined || candidate === null) {
      return { ok: false, error: 'ICE inválido' };
    }
    if (from !== role) {
      return { ok: false, error: 'Papel inconsistente' };
    }
    const arr = from === 'owner' ? s.iceFromOwner : s.iceFromStaff;
    arr.push(candidate);
    if (arr.length > MAX_ICE) {
      arr.splice(0, arr.length - MAX_ICE);
    }
    touch(s);
    return { ok: true };
  }

  return { ok: false, error: 'Ação desconhecida' };
}

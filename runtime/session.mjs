import { timingSafeEqual, randomBytes, createHmac } from 'node:crypto';

export function createSessionGuard(secret) {
  if (typeof secret !== 'string' || secret.length < 24) throw Error('PVS_SESSION_TOKEN must have at least 24 characters');
  const signingKey = randomBytes(32);
  const sessions = new Map();
  const equal = (left,right) => typeof left === 'string' && typeof right === 'string' &&
    Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left),Buffer.from(right));
  const originAllowed = req => {
    if (!req.headers.origin) return true;
    try { const origin=new URL(req.headers.origin); return ['http:','https:'].includes(origin.protocol) && origin.host===req.headers.host; }
    catch { return false; }
  };
  function issue() {
    const id = randomBytes(32).toString('base64url');
    const signed = id+'.'+createHmac('sha256',signingKey).update(id).digest('base64url');
    const now=Date.now();
    for(const [key,expiry] of sessions) if(expiry<now) sessions.delete(key);
    if(sessions.size>=1000) sessions.delete(sessions.keys().next().value);
    sessions.set(signed,now+12*60*60*1000);
    return signed;
  }
  function authenticated(req) {
    const session=(req.headers.cookie??'').split(';').map(part=>part.trim()).find(part=>part.startsWith('pvs_session='))?.slice(12);
    return Boolean(session && (sessions.get(session)??0)>Date.now());
  }
  return { checkPassword:value=>equal(value,secret), issue, authenticated, originAllowed,
    revoke:req=>{const value=(req.headers.cookie??'').split(';').map(part=>part.trim()).find(part=>part.startsWith('pvs_session='))?.slice(12);sessions.delete(value);},
    allowed:req=>authenticated(req)&&originAllowed(req) };
}

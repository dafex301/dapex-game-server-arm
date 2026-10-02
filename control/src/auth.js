import { timingSafeEqual } from 'node:crypto';

function equalSecret(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAuth(config) {
  return function auth(request, response, next) {
    if (config.authDisabled) {
      request.actor = 'development';
      next();
      return;
    }
    const bearer = request.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (config.internalToken && equalSecret(bearer, config.internalToken)) {
      request.actor = 'internal-service';
      next();
      return;
    }
    const email = request.get('cf-access-authenticated-user-email')?.trim().toLowerCase();
    if (email && config.allowedEmails.has(email)) {
      request.actor = email;
      next();
      return;
    }
    response.status(401).json({ error: 'Cloudflare Access authentication is required' });
  };
}

export function requireSameOrigin(config) {
  return function sameOrigin(request, response, next) {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return next();
    if (request.actor === 'internal-service') return next();
    const origin = request.get('origin');
    if (!origin || origin !== new URL(config.baseUrl).origin) {
      response.status(403).json({ error: 'Cross-origin mutation rejected' });
      return;
    }
    next();
  };
}

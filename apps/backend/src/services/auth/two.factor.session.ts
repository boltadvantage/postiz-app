// Bolt Advantage: helpers shared by the login flow and the 2FA settings routes.
import { Response } from 'express';
import { AuthService as AuthChecker } from '@gitroom/helpers/auth/auth.service';
import { getCookieUrlFromDomain } from '@gitroom/helpers/subdomain/subdomain.management';

const CHALLENGE_PURPOSE = '2fa-login';
const CHALLENGE_SECONDS = 5 * 60;

/**
 * Proof that the password step passed. It is not a session: it only lets the
 * holder submit a code for this user within five minutes.
 */
export function issueTwoFactorChallenge(userId: string) {
  return AuthChecker.signJWT({
    id: userId,
    purpose: CHALLENGE_PURPOSE,
    exp: Math.floor(Date.now() / 1000) + CHALLENGE_SECONDS,
  });
}

export function readTwoFactorChallenge(token: string): string | null {
  try {
    const payload = AuthChecker.verifyJWT(token) as {
      id?: string;
      purpose?: string;
    };
    if (payload?.purpose !== CHALLENGE_PURPOSE || typeof payload.id !== 'string') {
      return null;
    }
    return payload.id;
  } catch (err) {
    return null;
  }
}

export function userIdFromJwt(jwt: string): string {
  return (AuthChecker.verifyJWT(jwt) as { id: string }).id;
}

/**
 * In NOT_SECURED mode the frontend saves `auth` itself as a host-only cookie.
 * If NOT_SECURED is later turned off, that copy outlives every server-set one,
 * and because browsers send it first it shadows the real session. Once 2FA
 * rejects it the app reloads forever, so clear it whenever we set or drop auth.
 */
export function clearHostOnlyAuthCookie(response: Response) {
  if (process.env.NOT_SECURED) {
    return;
  }
  response.cookie('auth', '', { path: '/', expires: new Date(0) });
}

/** Same cookie the stock login sets. */
export function setAuthCookie(response: Response, jwt: string) {
  clearHostOnlyAuthCookie(response);
  response.cookie('auth', jwt, {
    domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
    ...(!process.env.NOT_SECURED
      ? {
          secure: true,
          httpOnly: true,
          sameSite: 'none',
        }
      : {}),
    expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
  });

  if (process.env.NOT_SECURED) {
    response.header('auth', jwt);
  }
}

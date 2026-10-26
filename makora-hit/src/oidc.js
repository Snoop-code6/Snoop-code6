// Connexion via un fournisseur OpenID Connect (Google Workspace, Microsoft 365…) :
// flux « authorization code » avec PKCE, et vérification complète du jeton d'identité.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const ALGORITHMS = {
  RS256: { hash: 'sha256' },
  ES256: { hash: 'sha256', dsaEncoding: 'ieee-p1363' },
};

export class OidcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function createOidc({
  issuer, clientId, clientSecret, redirectUri, label = 'SSO', allowedDomains = [], trustEmail = false, fetchImpl = fetch,
}) {
  let discovery = null;
  let keys = null;

  async function getJson(url, options) {
    const res = await fetchImpl(url, options);
    if (!res.ok) throw new OidcError('provider', `Réponse ${res.status} du fournisseur d'identité (${new URL(url).pathname}).`);
    return res.json();
  }

  async function config() {
    discovery ??= await getJson(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    return discovery;
  }

  async function signingKey(kid, refresh = false) {
    if (!keys || refresh) keys = (await getJson((await config()).jwks_uri)).keys ?? [];
    const jwk = keys.find((k) => k.kid === kid);
    if (jwk) return createPublicKey({ key: jwk, format: 'jwk' });
    // Le fournisseur a peut-être changé de clé : on recharge une fois.
    return refresh ? null : signingKey(kid, true);
  }

  async function verifyIdToken(token, nonce) {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw new OidcError('token', 'Jeton d’identité malformé.');
    const [rawHeader, rawClaims, rawSignature] = parts;
    const header = JSON.parse(Buffer.from(rawHeader, 'base64url'));
    const algorithm = ALGORITHMS[header.alg];
    if (!algorithm) throw new OidcError('token', `Algorithme de signature refusé : ${header.alg}.`);
    const key = await signingKey(header.kid);
    if (!key) throw new OidcError('token', 'Clé de signature inconnue.');
    const valid = verify(algorithm.hash, Buffer.from(`${rawHeader}.${rawClaims}`),
      algorithm.dsaEncoding ? { key, dsaEncoding: algorithm.dsaEncoding } : key, Buffer.from(rawSignature, 'base64url'));
    if (!valid) throw new OidcError('token', 'Signature du jeton invalide.');

    const claims = JSON.parse(Buffer.from(rawClaims, 'base64url'));
    const now = Date.now() / 1000;
    const audiences = [claims.aud].flat();
    if (claims.iss !== (await config()).issuer) throw new OidcError('token', 'Émetteur du jeton inattendu.');
    if (!audiences.includes(clientId)) throw new OidcError('token', 'Jeton destiné à une autre application.');
    if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new OidcError('token', 'Jeton expiré.');
    if (claims.nonce !== nonce) throw new OidcError('token', 'Jeton rejoué ou ne correspondant pas à cette connexion.');
    return claims;
  }

  return {
    label,

    // Paramètres à conserver jusqu'au retour du fournisseur.
    newAttempt: () => ({ state: b64url(randomBytes(24)), nonce: b64url(randomBytes(24)), verifier: b64url(randomBytes(32)) }),

    async authorizationUrl({ state, nonce, verifier }) {
      const url = new URL((await config()).authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: b64url(createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      return url.href;
    },

    // Échange le code contre un jeton d'identité vérifié, et renvoie { email, name }.
    async complete({ code, verifier, nonce }) {
      const tokens = await getJson((await config()).token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret, code_verifier: verifier,
        }),
      });
      const claims = await verifyIdToken(tokens.id_token, nonce);
      const email = String(claims.email ?? '').trim().toLowerCase();
      const verified = claims.email_verified === true || claims.email_verified === 'true' || trustEmail;
      if (!email || !verified) throw new OidcError('email', 'Le fournisseur n’a pas confirmé votre adresse email.');
      const domain = email.split('@')[1];
      return { email, name: String(claims.name ?? '').trim() || email.split('@')[0], domainAllowed: allowedDomains.includes(domain) };
    },
  };
}

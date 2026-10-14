/**
 * Pairing: the string a phone scans to reach this daemon.
 *
 * The offer carries the server id, the daemon's public key, and the relay
 * endpoint. The phone uses the public key to run the end-to-end key exchange,
 * so the relay never sees plaintext and never needs to be trusted.
 *
 * @module dsh-paseo-server/paseo/pairing
 */
/** Default Paseo app origin that renders the offer fragment. */
export const DEFAULT_APP_BASE_URL = 'https://app.paseo.sh';
/**
 * Build the pairing offer and its two serialized forms.
 * @param input - identity, relay endpoint, and app origin.
 * @returns the offer plus the app URL and relay URI.
 */
export function buildPairingInfo(input) {
    const offer = {
        v: 2,
        serverId: input.serverId,
        daemonPublicKeyB64: input.publicKeyB64,
        relay: { endpoint: input.relayEndpoint, useTls: input.useTls },
    };
    const appBaseUrl = (input.appBaseUrl ?? DEFAULT_APP_BASE_URL).replace(/\/+$/, '');
    const encoded = Buffer.from(JSON.stringify(offer), 'utf8').toString('base64url');
    return {
        offer,
        url: `${appBaseUrl}/#offer=${encoded}`,
        uri: serializeRelayUri(offer, input.password),
    };
}
/** `relay://` form accepted by the Paseo CLI and app deep links. */
export function serializeRelayUri(offer, password) {
    const url = new URL(`relay://${offer.relay.endpoint}/${encodeURIComponent(offer.serverId)}`);
    url.searchParams.set('key', offer.daemonPublicKeyB64);
    if (offer.relay.useTls)
        url.searchParams.set('ssl', 'true');
    if (password !== undefined && password.length > 0)
        url.searchParams.set('password', password);
    return url.toString();
}
/** Decode an offer fragment, for the pairing surface's own verification. */
export function parseOfferFragment(fragment) {
    const index = fragment.indexOf('#offer=');
    if (index < 0)
        return null;
    const encoded = fragment.slice(index + '#offer='.length);
    try {
        const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        return value.v === 2 ? value : null;
    }
    catch {
        return null;
    }
}

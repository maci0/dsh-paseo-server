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
export declare const DEFAULT_APP_BASE_URL = "https://app.paseo.sh";
/** Connection offer as Paseo 0.11.2 defines it. */
export interface ConnectionOffer {
    readonly v: 2;
    readonly serverId: string;
    readonly daemonPublicKeyB64: string;
    readonly relay: {
        readonly endpoint: string;
        readonly useTls: boolean;
    };
}
/** Everything a pairing surface needs to display. */
export interface PairingInfo {
    /** Offer object, as stored by the client. */
    readonly offer: ConnectionOffer;
    /** URL the mobile app opens or scans. */
    readonly url: string;
    /** `relay://` form the CLI accepts for `--host`. */
    readonly uri: string;
}
/**
 * Build the pairing offer and its two serialized forms.
 * @param input - identity, relay endpoint, and app origin.
 * @returns the offer plus the app URL and relay URI.
 */
export declare function buildPairingInfo(input: {
    readonly serverId: string;
    readonly publicKeyB64: string;
    readonly relayEndpoint: string;
    readonly useTls: boolean;
    readonly appBaseUrl?: string;
    readonly password?: string;
}): PairingInfo;
/** `relay://` form accepted by the Paseo CLI and app deep links. */
export declare function serializeRelayUri(offer: ConnectionOffer, password?: string): string;
/** Decode an offer fragment, for the pairing surface's own verification. */
export declare function parseOfferFragment(fragment: string): ConnectionOffer | null;
/**
 * Render a pairing URL as terminal-block QR text.
 *
 * This is what `daemon.get_pairing_offer.response.qr` carries and what the
 * `paseo pair` command prints, so a terminal can show the code without an
 * image surface.
 * @param url - pairing URL to encode.
 * @returns one line per QR row, or null when rendering failed.
 */
export declare function renderPairingQr(url: string): Promise<string | null>;

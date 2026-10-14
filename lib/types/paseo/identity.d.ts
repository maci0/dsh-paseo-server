/**
 * Daemon identity: the server id the relay routes on and the Curve25519 key
 * pair that terminates relay end-to-end encryption.
 *
 * Both are generated once and reused, so a phone that paired yesterday still
 * reaches this daemon today. Files are written owner-only, matching the
 * credential-handling rule for local secrets.
 *
 * @module dsh-paseo-server/paseo/identity
 */
import nacl from 'tweetnacl';
/** One Curve25519 key pair, base64 encoded as Paseo stores it. */
export interface KeyPair {
    readonly publicKeyB64: string;
    readonly secretKeyB64: string;
}
/** Persisted daemon identity. */
export interface DaemonIdentity {
    readonly serverId: string;
    readonly keyPair: KeyPair;
}
/**
 * Read the identity in `directory`, generating and persisting it when absent.
 * @param directory - plugin data directory.
 * @returns the stable identity.
 */
export declare function loadOrCreateIdentity(directory: string): DaemonIdentity;
/** Decode a stored key pair back to raw bytes. */
export declare function decodeKeyPair(keyPair: KeyPair): nacl.BoxKeyPair;
/** Generate a fresh daemon key pair. */
export declare function generateKeyPair(): KeyPair;

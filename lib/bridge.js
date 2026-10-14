/**
 * The surface the Paseo protocol layer needs from the agent runtime behind it.
 *
 * The Paseo wire layer never reaches into DeepSeek Harness directly: it calls
 * this interface, so the protocol can be tested against a static host and the
 * DSH binding stays one file that maps concepts.
 *
 * @module dsh-paseo-server/bridge
 */
export {};

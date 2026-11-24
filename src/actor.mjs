/** Constituted-entity actor address: `actor:` + 43-char base64url SHA-256 digest (EAVT constitute law). Values are data; no literal actor may be welded into code. */
export const ACTOR_ADDRESS_PATTERN = /^actor:[A-Za-z0-9_-]{43}$/u;

/**
 * Asserts one actor identifier is a well-formed constituted address.
 * @param {string} actor - candidate actor address
 * @param {string} context - error prefix naming the carrier being validated
 * @returns {string} the validated actor address
 * @throws {Error} when the value is not a constituted actor address
 */
export function assertActorAddress(actor, context) {
  if (typeof actor !== "string" || !ACTOR_ADDRESS_PATTERN.test(actor)) {
    throw new Error(`${context} names no valid constituted actor address`);
  }
  return actor;
}

/** Existing policy records may retain their named enterprise URNs. */
export function assertPolicyActor(actor, context) {
  if (typeof actor === "string" && actor.startsWith("urn:ame:") && actor.length > "urn:ame:".length) return actor;
  return assertActorAddress(actor, context);
}

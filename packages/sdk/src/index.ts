/**
 * @slab/sdk — the frontend's single door into the protocol.
 *
 * The frontend does NOT deserialize accounts by hand and does NOT derive PDAs
 * by hand. Everything goes through here, so a layout change breaks the SDK
 * build instead of breaking the screen in silence.
 */

export * as math from "./math.js";
export * from "./views.js";
export * from "./chain.js";
export * from "@slab/types";

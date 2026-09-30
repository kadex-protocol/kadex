/**
 * @slab/sdk — a porta unica do frontend para o protocolo.
 *
 * O frontend NAO desserializa conta na mao e NAO deriva PDA na mao. Tudo passa
 * por aqui, para que uma mudanca de layout quebre a compilacao do SDK em vez
 * de quebrar a tela silenciosamente.
 */

export * as math from "./math.js";
export * from "./views.js";
export * from "@slab/types";

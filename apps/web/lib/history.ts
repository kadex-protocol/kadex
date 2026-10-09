/** 24 hours of five-minute points. Shared by the route and the chart. */
export const HISTORY_POINTS = 288;
export const HISTORY_STEP_SECS = 300;

/** What `/api/index-history` returns. Prices are WAD, as strings: JSON has no BigInt. */
export interface IndexHistoryWire {
  step: number;
  points: { ts: number; price: string }[];
}

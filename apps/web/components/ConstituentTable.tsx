import Link from "next/link";
import { CONSTITUENTS, fmtBps } from "@/lib/market";

/**
 * The basket, as a ledger rather than a grid of cards. Weights are right
 * aligned and tabular so the column reads as a column.
 */
export function ConstituentTable({ showWeights = true }: { showWeights?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="ledger">
        <thead>
          <tr>
            <th scope="col">Constituent</th>
            <th scope="col">Category</th>
            {showWeights && (
              <th scope="col" className="num">
                Weight
              </th>
            )}
            <th scope="col" className="num">
              Details
            </th>
          </tr>
        </thead>
        <tbody>
          {CONSTITUENTS.map((c) => (
            <tr key={c.id}>
              <td className="name">{c.name}</td>
              <td style={{ color: "var(--ink-soft)" }}>{c.category}</td>
              {showWeights && <td className="num">{fmtBps(c.weightBps)}</td>}
              <td className="num">
                <Link href="/index-methodology" className="link-action">
                  View&nbsp;→
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

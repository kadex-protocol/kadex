"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { readVaultInventory, type InventoryRow } from "@kadex/sdk";
import { CLUSTER } from "@/lib/cluster";
import { loadVaultCard } from "@/lib/collectorCrypt";
import { titleParts, shortAddress } from "@/lib/cardText";
import { fmtUsd } from "@/lib/market";
import { useWallet } from "@/lib/wallet";

/**
 * The cards a wallet has locked, or holds fractions of, on the cluster the
 * app points at: fractions held against the whole supply, and what is still
 * missing before it can redeem. Renders nothing without a wallet or a cluster.
 */
export function VaultInventory() {
  const { status, publicKey } = useWallet();
  const [rows, setRows] = useState<InventoryRow[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRows(null);
    setError(null);
    if (!CLUSTER || status !== "connected" || !publicKey) return;
    readVaultInventory(CLUSTER.connection, publicKey)
      .then((r) => {
        if (!live) return;
        setRows(r);
        // Names come from Collector Crypt when it knows the asset; the address otherwise.
        for (const row of r) {
          const key = row.asset.toBase58();
          loadVaultCard(key)
            .then((c) => live && setNames((n) => ({ ...n, [key]: titleParts(c).title })))
            .catch(() => {});
        }
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not read the vault."));
    return () => {
      live = false;
    };
  }, [status, publicKey]);

  if (!CLUSTER || status !== "connected" || !publicKey) return null;

  return (
    <section className="panel" aria-labelledby="inv-h">
      <h2 className="title sm" id="inv-h">Your vaulted cards</h2>
      {error && <p className="hint bad" role="alert">{error}</p>}
      {!error && rows === null && <p className="sub">Reading the vault…</p>}
      {rows?.length === 0 && <p className="sub">Nothing locked, and no fractions of a locked card in this wallet.</p>}
      {rows && rows.length > 0 && (
        <div className="t-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Card</th>
                <th className="r">You hold</th>
                <th className="r">Supply</th>
                <th className="r">Still needed</th>
                <th className="r">At appraisal</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const key = r.asset.toBase58();
                return (
                  <tr key={key}>
                    <td>
                      <Link href={`/vault/${key}`}>{names[key] ?? shortAddress(key)}</Link>
                      {r.deposited && <span className="pill" style={{ marginLeft: 8 }}>You vaulted it</span>}
                    </td>
                    <td className="r n">{fmtUsd(r.held, 2)}</td>
                    <td className="r n">{fmtUsd(r.supply, 2)}</td>
                    <td className="r n">{r.missing === 0n ? "—" : fmtUsd(r.missing, 2)}</td>
                    <td className="r n">{r.missing === 0n ? "—" : `$${fmtUsd(r.missingAtAppraisal, 2)}`}</td>
                    <td className="r">
                      {r.missing === 0n ? (
                        <Link className="btn" href={`/vault/${key}`}>Redeem</Link>
                      ) : (
                        <span className="sub">Buy the rest to redeem</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="fine">
        Redeeming burns the whole supply. &quot;At appraisal&quot; is 1 fraction per $1 of the card&apos;s appraisal, not
        a market price: buying the rest may cost more or less.
      </p>
    </section>
  );
}

import { QSWAP_INDEX, QX_INDEX, structReader } from "./rpc.ts";
import type { QubicRpc } from "./rpc.ts";

/** What QX and QSwap charge to take over the management of shares (QU). The same for every asset. */
export async function fetchTransferFees(rpc: QubicRpc): Promise<{ qx: number; qswap: number }> {
  const [qx, qswap] = await Promise.all([rpc.query(QX_INDEX, 1), rpc.query(QSWAP_INDEX, 1)]);
  return { qx: structReader(qx).u32(4), qswap: structReader(qswap).u32(8) };
}

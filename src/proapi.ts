import type { ProRules } from "./procover.ts";
import type { Route } from "./routes.ts";
import type { PaymentRecord } from "./usage.ts";

/**
 * Who is covered by a Max pass, as a service and endpoints. NOT part of this repository: this keeps the shapes, with a service that does nothing and no endpoints,
 * so the server still builds and runs. QMax's own server runs the real one.
 */
export interface ProServiceDeps {
  usage: { allPayments(): PaymentRecord[]; refreshWallet(wallet: string): Promise<PaymentRecord[]> };
  rules: ProRules;
  file?: string;
  now?: () => number;
}

export class ProService {
  constructor(_d: ProServiceDeps) {}
  flush(): void {}
}

export function proRoutes(_service: ProService): Route[] {
  return [];
}

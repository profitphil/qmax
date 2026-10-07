export { type GetSnapsResponse, type Snap } from "./snap";
export { type Account } from "./account";

interface EthereumProvider {
  isMetaMask?: boolean;
  detected?: Array<EthereumProvider>;
  request: (request: { method: string; params?: any }) => Promise<any>;
  setProvider?: (provider: EthereumProvider) => void;
  providers?: Array<EthereumProvider>;
}

// EIP-6963: Multi Injected Provider Discovery
interface EIP6963ProviderInfo {
  rdns: string;
  uuid: string;
  name: string;
  icon: string;
}

interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo;
  provider: EthereumProvider;
}

interface EIP6963AnnounceProviderEvent extends CustomEvent {
  type: "eip6963:announceProvider";
  detail: EIP6963ProviderDetail;
}

declare global {
  interface Window {
    ethereum: EthereumProvider;
  }
  interface WindowEventMap {
    "eip6963:announceProvider": EIP6963AnnounceProviderEvent;
  }
}

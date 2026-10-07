import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { WalletConnectProvider } from "./wallet/WalletConnectContext.tsx";
import { QubicConnectProvider } from "./wallet/QubicConnectContext.tsx";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { SettingsProvider } from "./settings.tsx";
import { MaxModeProvider } from "./maxmode.tsx";
import { useTheme } from "./theme.ts";
import { startUsageReporting } from "./usage.ts";
import "./style.css";
// Each feature keeps its own styles in web/styles/; they all load here. The terminal overrides are imported by name, after everything else: a glob's imports run before
// the ones written above it, so left in the glob they would load before style.css and lose to it.
import.meta.glob(["./styles/*.css", "!./styles/zz-terminal.css"], { eager: true });
import "./styles/zz-terminal.css";

startUsageReporting();

function ThemedToaster() {
  const { theme } = useTheme();
  return <Toaster theme={theme} position="bottom-right" />;
}

createRoot(document.getElementById("root")!).render(
  <WalletConnectProvider>
    <QubicConnectProvider>
      <SettingsProvider>
        <MaxModeProvider>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </MaxModeProvider>
        <ThemedToaster />
      </SettingsProvider>
    </QubicConnectProvider>
  </WalletConnectProvider>,
);

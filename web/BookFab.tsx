import type { MarketTab } from "./MarketPanel.tsx";
import { Icon } from "./ui.tsx";

/**
 * The round button at a phone's right edge, where a thumb rests, that switches the chart screen between the price chart and the order book (the market panel's own two tabs, in
 * place: nothing opens over the screen). On the chart it says "Book" and shows the shape of a book, two sellers' bars above two buyers' bars; on the book it says "Chart" and goes back.
 */
export function BookFab({ symbol, showingBook, onClick }: { symbol: string; showingBook: boolean; onClick: () => void }) {
  const label = showingBook ? `Back to the ${symbol} price chart` : `Show the ${symbol} order book`;
  return (
    <button type="button" className="book-fab" onClick={onClick} aria-label={label} title={showingBook ? "Price chart" : "Order book"}>
      {showingBook ? (
        <Icon name="chart" size={22} />
      ) : (
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <rect className="sell" x="4" y="3.5" width="10" height="3.2" rx="1" />
          <rect className="sell" x="4" y="8" width="15" height="3.2" rx="1" />
          <rect className="buy" x="4" y="12.8" width="15" height="3.2" rx="1" />
          <rect className="buy" x="4" y="17.3" width="9" height="3.2" rx="1" />
        </svg>
      )}
      <span>{showingBook ? "Chart" : "Book"}</span>
    </button>
  );
}

/** The button's tab: the order book from anywhere else, the price chart from the book. */
export const bookFabTarget = (tab: MarketTab): "book" | "chart" => (tab === "book" ? "chart" : "book");

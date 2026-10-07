Asset logos

These pictures are copies of the logos qubictrade.com shows for Qubic assets (https://qubictrade.com/public/assets/icons/), saved here so QMax can show them from its
own address without loading anything from another site. They belong to the projects they stand for. Many assets have no logo of their own there (the site shows the
same placeholder for them); those are left out and QMax shows its lettered badge instead.

index.json lists them by asset symbol and issuer, with one picture for the light theme and one for the dark theme (or one picture for both). Pictures are shrunk to
128 pixels. `npm run logos` fetches what is missing (`-- --force` fetches everything again, `-- --dry-run` only reports); it needs the QMax API running, because
the API lists the assets. Last fetched: 2026-10-06T17:22:26.563Z. 52 assets have a logo.

The Qubic logo itself (QU, not an asset) is ../brand/qubic.png: the 64 pixel picture qubictrade.com shows for Qubic (it takes it from Gate.io's coin icons, icon.gateimg.com/images/coin_icon/64/qubic.png). Swap the file for Qubic's official artwork if you have it; QMax draws it in the price chip, the swap panel and the Qubic chart.

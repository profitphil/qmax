// Set the theme before the first paint so a light-theme visitor never sees a dark flash.
// A file of its own (not inline in index.html) so the page's Content-Security-Policy can forbid inline scripts altogether.
(function () {
  try {
    var v = localStorage.getItem("qmax.theme");
    var t = v === "light" || v === "dark" ? v : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    document.documentElement.style.colorScheme = t;
  } catch (e) {}
})();

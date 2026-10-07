// The Qubic library is published without file extensions in its deep imports, which Node's own resolver refuses.
// Bundlers (the site, the bot, the SDK build) cope; this lets the tests load the same code unbundled.
export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@qubic-lib/qubic-ts-library/dist/") && !/\.[cm]?js$/.test(specifier)) {
    try {
      return await next(`${specifier}.js`, context);
    } catch {
      return next(`${specifier}/index.js`, context);
    }
  }
  return next(specifier, context);
}

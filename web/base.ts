/** Where the API is. `import.meta.env` does not exist outside Vite (in tests), hence the `?.`. */
export const BASE = (import.meta.env?.VITE_API_URL as string | undefined) ?? "/api";

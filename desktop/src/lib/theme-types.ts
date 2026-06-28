/** JSON-driven theme definition. Each theme is a standalone JSON file in styles/themes/. */
export interface ThemeJson {
  name: string
  colorScheme: 'dark' | 'light'
  /** Base color, shadow, and overlay variables. */
  variables: Record<string, string>
  /** Solid-mode surface tokens (opaque, no blur). */
  surfaces: Record<string, string>
  /** Glass-mode surface tokens (translucent, with backdrop blur via color-mix()). */
  glass: Record<string, string>
}

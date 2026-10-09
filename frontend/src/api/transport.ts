/**
 * Where API requests go. The local-server build sends them over the network to
 * `cost-inspector serve`. The in-browser build (`vite build --mode browser`) runs the same
 * Python backend in a Web Worker and hands each request to it; nothing leaves the device.
 */
export const IN_BROWSER = __BROWSER_BUILD__

export type Transport = (path: string, init?: RequestInit) => Promise<Response>

export const transport: Transport = __BROWSER_BUILD__
  ? async (path, init) => (await import('../runtime/bridge')).request(path, init)
  : (path, init) => fetch(path, init)

/** Where stored data lives, for user-facing copy. */
export const DATA_HOME = IN_BROWSER ? 'this browser' : 'this machine'

/** Browser build only: delete the database saved in this browser. */
export async function clearBrowserData(): Promise<void> {
  if (!__BROWSER_BUILD__) return
  const { clearSavedData } = await import('../runtime/bridge')
  await clearSavedData()
}

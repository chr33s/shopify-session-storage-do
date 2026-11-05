import { LEGACY_OFFLINE_PREFIX } from './types.js'

export type ShopOptions = {
  /** Accept `*.myshopify.io` (Shopify's internal development domains). Off by default. */
  allowMyshopifyIo?: boolean
}

const MYSHOPIFY_COM = /^[a-z0-9][a-z0-9_-]*\.myshopify\.com$/
const MYSHOPIFY_IO = /^[a-z0-9][a-z0-9_-]*\.myshopify\.io$/

/**
 * The canonical form of a shop domain, or `undefined` if it isn't one. The
 * result names the shop's Durable Object and is the host token calls go to, so
 * nothing else may reach either.
 */
export function canonicalShop(input: string, options: ShopOptions = {}): string | undefined {
  if (typeof input !== 'string') return undefined
  const shop = input.trim().toLowerCase().replace(/\/+$/, '')
  if (MYSHOPIFY_COM.test(shop)) return shop
  if (options.allowMyshopifyIo && MYSHOPIFY_IO.test(shop)) return shop
  return undefined
}

/** The shop of an offline session id (`offline_<shop>`), or `undefined` for anything else. */
export function shopFromOfflineId(id: string, options: ShopOptions = {}): string | undefined {
  if (typeof id !== 'string' || !id.startsWith(LEGACY_OFFLINE_PREFIX)) return undefined
  return canonicalShop(id.slice(LEGACY_OFFLINE_PREFIX.length), options)
}

export function offlineId(shop: string): string {
  return `${LEGACY_OFFLINE_PREFIX}${shop}`
}

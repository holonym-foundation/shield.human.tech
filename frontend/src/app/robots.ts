import type { MetadataRoute } from 'next'
import { IS_PROD_DEPLOYMENT } from '@/config'

const SITE_URL = 'https://shield.human.tech'

// Transactional app states carry no indexable content and can expose tx params in URLs.
const APP_STATE_PATHS = ['/progress', '/claim-fuel', '/complete', '/fee-juice', '/activity', '/api/']

export default function robots(): MetadataRoute.Robots {
  // Only the production (Ethereum-mainnet) deployment is indexable. Non-prod hosts
  // (testnet.shield.human.tech, Vercel previews) block all crawling so they never get
  // indexed alongside — or compete with — the canonical prod site. Their pages still
  // canonicalize to shield.human.tech, so any leaked URL consolidates onto prod.
  if (!IS_PROD_DEPLOYMENT) {
    return { rules: [{ userAgent: '*', disallow: '/' }] }
  }
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: APP_STATE_PATHS,
      },
      {
        // Explicitly welcome AI crawlers so the /docs guides are citable by agents.
        userAgent: [
          'GPTBot',
          'OAI-SearchBot',
          'ChatGPT-User',
          'ClaudeBot',
          'Claude-Web',
          'PerplexityBot',
          'Google-Extended',
          'CCBot',
        ],
        allow: '/',
        disallow: APP_STATE_PATHS,
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  }
}

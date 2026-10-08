import type { NextConfig } from 'next'
import webpack from 'webpack'
import path from 'path'
import fs from 'fs'

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || undefined

// The root build proxies each legacy Aztec version's path to the frozen deployment that serves it.
// Legacy builds (basePath set) never rewrite: only the current build owns the registry.
function legacyVersionRewrites() {
  if (BASE_PATH) return []
  const env = process.env.NEXT_PUBLIC_AZTEC_ENV ?? ''
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'networks.json'), 'utf8'))
  const versions: { path: string; status: string; origin?: string }[] = registry[env] ?? []
  return versions
    .filter((v) => v.status === 'legacy' && v.origin)
    .flatMap((v) => [
      { source: v.path, destination: `${v.origin}${v.path}` },
      { source: `${v.path}/:rest*`, destination: `${v.origin}${v.path}/:rest*` },
    ])
}

const nextConfig: NextConfig = {
  basePath: BASE_PATH,
  async rewrites() {
    return { beforeFiles: legacyVersionRewrites() }
  },
  // bb.js lives in the workspace-root node_modules/.pnpm (not under frontend/),
  // so the lambda needs the monorepo as its tracing root for Vercel to copy
  // files that resolve above this Next project.
  outputFileTracingRoot: path.join(__dirname, '..'),
  // NOTE: COOP/COEP headers were removed because 'same-origin' COOP blocks
  // the WaaP/Silk iframe (waap.xyz) from communicating via postMessage,
  // breaking L1 wallet connections entirely. SharedArrayBuffer (needed by
  // Barretenberg WASM) works on localhost without these headers. For
  // production, a different strategy is needed (e.g. service worker proxy
  // or isolating WASM in a cross-origin-isolated iframe).
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ]
  },
  // Next's NFT trace can't see the runtime readFile that loads
  // barretenberg-threads.wasm.gz. Two patterns: the first matches when bb.js
  // is installed under frontend/node_modules/.pnpm (legacy per-package
  // install); the second matches when it's hoisted to the workspace root
  // (the layout produced by `pnpm install` from the monorepo root, which
  // is what CI does).
  outputFileTracingIncludes: {
    '/api/**/*': [
      './node_modules/.pnpm/@aztec-foundation+bb.js*/node_modules/@aztec-foundation/bb.js/dest/**/*.wasm.gz',
      '../node_modules/.pnpm/@aztec-foundation+bb.js*/node_modules/@aztec-foundation/bb.js/dest/**/*.wasm.gz',
    ],
  },
  // Keep @aztec-foundation/bb.js as external on the server so the WASM file resolves
  // from node_modules instead of being broken by webpack bundling.
  transpilePackages: ['@human.tech/clean.sdk'],
  serverExternalPackages: [
    '@aztec-foundation/bb.js',
    '@aztec-labs/aztec.js',
    '@aztec-labs/foundation',
    '@aztec-labs/stdlib',
    'pino',
    'pino-pretty',
  ],
  // Use webpack for polyfills compatibility
  webpack: (config, { isServer }) => {
    // Add polyfills for Node.js built-ins in the browser
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        buffer: require.resolve('buffer'),
        crypto: require.resolve('crypto-browserify'),
        stream: require.resolve('stream-browserify'),
        util: require.resolve('util'),
        url: require.resolve('url'),
        assert: require.resolve('assert'),
        http: require.resolve('stream-http'),
        https: require.resolve('https-browserify'),
        os: require.resolve('os-browserify/browser'),
        path: require.resolve('path-browserify'),
        zlib: require.resolve('browserify-zlib'),
        fs: false,
        net: false,
        tls: false,
      }

      // Provide Buffer globally
      config.plugins.push(
        new webpack.ProvidePlugin({
          Buffer: ['buffer', 'Buffer'],
          process: 'process/browser',
        }),
      )

    }

    // pnpm nests @aztec-labs/aztec.js under its dependents, so packages that import
    // its subpath exports (e.g. @aztec-foundation/aztec-standards' generated
    // Token.js -> '@aztec-labs/aztec.js/abi') can't resolve them. serverExternalPackages
    // only externalizes the bare package, not these subpaths. Alias them to the
    // hoisted package so both the server and client bundles resolve.
    config.resolve.alias = {
      ...config.resolve.alias,
      '@aztec-labs/aztec.js/abi': require.resolve('@aztec-labs/aztec.js/abi'),
      '@aztec-labs/aztec.js/contracts': require.resolve('@aztec-labs/aztec.js/contracts'),
      '@aztec-labs/aztec.js/fields': require.resolve('@aztec-labs/aztec.js/fields'),
    }

    return config
  },
}

export default nextConfig

import type { NextConfig } from "next";
import webpack from 'webpack';

const nextConfig: NextConfig = {
  // NOTE: COOP/COEP headers were removed because 'same-origin' COOP blocks
  // the WaaP/Silk iframe (waap.xyz) from communicating via postMessage,
  // breaking L1 wallet connections entirely. SharedArrayBuffer (needed by
  // Barretenberg WASM) works on localhost without these headers. For
  // production, a different strategy is needed (e.g. service worker proxy
  // or isolating WASM in a cross-origin-isolated iframe).
  outputFileTracingIncludes: {
    '/api/**/*': [
      './node_modules/.pnpm/@aztec+bb.js*/node_modules/@aztec/bb.js/dest/**/*.wasm.gz',
      './node_modules/.pnpm/@aztec+bb.js*/node_modules/@aztec/bb.js/dest/**/*.js'
    ],
    '/**/*': [
      './node_modules/.pnpm/@aztec+bb.js*/node_modules/@aztec/bb.js/dest/**/*.wasm.gz',
      './node_modules/.pnpm/@aztec+bb.js*/node_modules/@aztec/bb.js/dest/**/*.js'
    ],
  },
  // Keep @aztec/bb.js as external on the server so the WASM file resolves
  // from node_modules instead of being broken by webpack bundling.
  serverExternalPackages: [
    '@aztec/bb.js',
    '@aztec/aztec.js',
    '@aztec/foundation',
    '@aztec/stdlib',
    '@aztec/circuits.js',
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
      };

      // Provide Buffer globally
      config.plugins.push(
        new webpack.ProvidePlugin({
          Buffer: ['buffer', 'Buffer'],
          process: 'process/browser',
        })
      );
    }

    return config;
  },
};

export default nextConfig;

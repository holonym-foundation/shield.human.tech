# Aztec Bridge UI 
A visual overview of the Aztec Bridge flow:

![Aztec Bridge Flow](docs/aztec%20bridge%20flow.png)

A comprehensive bridge application for transferring tokens between Ethereum (L1) and Aztec Network (L2), featuring a modern React/Next.js frontend with seamless Web3 integration.

## ⚠️ **TESTNET ONLY - SECURITY WARNING**

**🚨 THIS IS A TESTNET BRIDGE WITH KNOWN VULNERABILITIES 🚨**

- **NOT FOR PRODUCTION USE**: This bridge is designed for testing and development purposes only
- **KNOWN SECURITY ISSUES**: The bridge contains known vulnerabilities and should never be used with real funds
- **TESTNET TOKENS ONLY**: Only use with testnet tokens that have no real value
- **NO SECURITY GUARANTEES**: Do not rely on this code for any production or mainnet deployments
- **EDUCATIONAL PURPOSE**: This implementation is for learning and testing Aztec network functionality

**⚠️ USE AT YOUR OWN RISK - NEVER USE WITH REAL FUNDS ⚠️**

## 🌟 Overview

The Aztec Bridge UI enables users to:
- Bridge tokens between Ethereum Layer 1 and Aztec Layer 2
- Manage multiple token types (ERC20, NFTs)
- Interact with Aztec's privacy-preserving Layer 2 network
- Use sponsored transactions for improved UX
- Connect multiple wallet types including MetaMask and Silk Wallet

## 🏗️ Architecture

```
aztec-ui/
├── frontend/           # Next.js React application
├── bridge-script/      # Bridge automation scripts
├── l1-contracts/       # L1 smart contracts (Foundry)
├── aztec-contracts/    # L2 Aztec contracts (Noir)
└── .github/           # CI/CD workflows
```

### Key Components

- **Frontend**: Modern Next.js app with TypeScript, Tailwind CSS, and Web3 integrations
- **Bridge Scripts**: Automated bridging logic and deployment scripts
- **L1 Contracts**: Ethereum smart contracts for token portals and handlers
- **L2 Contracts**: Aztec Noir contracts for private token management

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ and pnpm
- Foundry (for L1 contracts)
- Aztec CLI (for L2 contracts)

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd aztec-ui

# Install frontend dependencies
cd frontend
pnpm install

# Install bridge script dependencies
cd ../bridge-script
pnpm install
```

### Environment Setup

Create environment files for sensitive configuration:

```bash
# Frontend (.env.local)
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_walletconnect_id
FAUCET_PRIVATE_KEY=0x...
ETHEREUM_RPC_URL=https://sepolia.infura.io/v3/...
ALCHEMY_API_KEY=your_alchemy_key

# Bridge Scripts (.env)
L1_URL=https://sepolia.infura.io/v3/...
MNEMONIC=your_test_mnemonic
PXE_URL=http://localhost:8081
```

### Development

```bash
# Start the frontend development server
cd frontend
pnpm dev

# The app will be available at http://localhost:3000
```

## 🔧 Development Scripts

### Frontend Commands

```bash
cd frontend

# Development
pnpm dev          # Start dev server with Turbo
pnpm build        # Build for production
pnpm start        # Start production server
pnpm lint         # Run ESLint
```

### Bridge Scripts

```bash
cd bridge-script

# Bridge operations
node index.js                    # Run main bridge script
node index-testnet.js           # Run testnet deployment
node fees.ts                    # Fee management utilities
```

### L1 Contracts (Foundry)

```bash
cd l1-contracts

# Contract operations
forge build       # Compile contracts
forge test         # Run tests
forge deploy       # Deploy contracts
```

## 🌐 Supported Networks

### Layer 1 (Ethereum)
- **Mainnet**: Ethereum Mainnet
- **Testnet**: Sepolia

### Layer 2 (Aztec)
- **Testnet**: Aztec Testnet (Chain ID: 1337)

## 🎨 Frontend Features

### Modern UI/UX
- **Design System**: Custom Tailwind CSS components
- **Responsive**: Mobile-first responsive design
- **Dark Mode**: Theme support
- **Toast Notifications**: Real-time user feedback

### Web3 Integration
- **Multi-Wallet Support**: MetaMask, Silk Wallet, WalletConnect
- **Token Management**: ERC20 and NFT support
- **Transaction Tracking**: Real-time transaction status
- **Gas Optimization**: Sponsored transactions support

### Data & Analytics
- **Datadog Integration**: Performance monitoring and logging
- **React Query**: Efficient data fetching and caching
- **Persistent State**: Local storage persistence

## 🔐 Security

### ⚠️ **CRITICAL SECURITY DISCLAIMER**
**THIS IS A TESTNET BRIDGE WITH KNOWN VULNERABILITIES - NOT PRODUCTION READY**

This bridge implementation:
- ❌ Contains known security vulnerabilities
- ❌ Has not undergone professional security audits
- ❌ Should never be used with real value or on mainnet
- ❌ May have unpatched critical security flaws
- ⚠️ Is intended for educational and testing purposes only

### Basic Security Practices Implemented
- ✅ Environment variables for all sensitive data
- ✅ Proper secret management in CI/CD
- ✅ No hardcoded production credentials
- ✅ Basic input validation
- ⚠️ **However, these do not address the underlying architectural vulnerabilities**

### Environment Variables
All sensitive information is properly managed through environment variables:
- API keys, private keys, and RPC URLs are never committed
- Production secrets are managed through Vercel and GitHub Secrets
- Test values are clearly marked and separated from production

### Known Limitations
- Bridge contracts may have reentrancy vulnerabilities
- Insufficient access controls in some components
- Lack of comprehensive validation in bridge operations
- Potential for fund loss due to architectural issues
- Missing security features required for production use

## 🚀 Deployment

### Vercel Deployment (Automated)
The project uses GitHub Actions for automated deployment:

```yaml
# Triggers on main branch push
# Deploys to both preview and production environments
# Manages environment variables securely
```

### Manual Deployment

```bash
# Build and deploy frontend
cd frontend
pnpm build
vercel --prod

# Deploy L1 contracts
cd l1-contracts
forge script script/Deploy.s.sol --broadcast
```

## 🧪 Testing

### Frontend Testing
```bash
cd frontend
pnpm test          # Run unit tests
pnpm test:e2e      # Run end-to-end tests
```

### Contract Testing
```bash
cd l1-contracts
forge test         # Test L1 contracts

cd aztec-contracts
aztec test         # Test L2 contracts
```

## 📚 API Reference

### Bridge API Endpoints

#### Faucet
- `POST /api/faucet` - Request test ETH for gas fees
- Body: `{ "address": "0x..." }`

#### Token Minting
- `POST /api/mint-tokens` - Mint test tokens
- Body: `{ "address": "0x...", "amount": "1000" }`

#### Alchemy Integration
- `GET /api/alchemy/nfts` - Fetch user NFTs
- `GET /api/alchemy/tokens-balances` - Get token balances

## 🛠️ Development Workflow

### Code Quality
- **ESLint**: Configured with Next.js and React rules
- **Prettier**: Code formatting
- **TypeScript**: Full type safety
- **Git Hooks**: Pre-commit validation

### Branch Strategy
- `main`: Production-ready code
- `develop`: Integration branch
- `feature/*`: Feature development

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

### Development Guidelines
- Follow TypeScript best practices
- Maintain test coverage
- Update documentation for new features
- Ensure security review for sensitive changes

## 📝 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🆘 Support

- **Documentation**: Check the `/docs` directory
- **Issues**: GitHub Issues for bug reports
- **Discussions**: GitHub Discussions for questions

## 🔗 Links

- [Aztec Network](https://aztec.network/)
- [Next.js Documentation](https://nextjs.org/docs)
- [Foundry Book](https://book.getfoundry.sh/)
- [Noir Documentation](https://noir-lang.org/)

---

Built with ❤️ for the Aztec ecosystem

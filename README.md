<div align="center">
  <a href="https://askemail.com/">
    <img src="https://raw.githubusercontent.com/G4brym/askemail/refs/heads/main/docs/logo.png" width="500" height="auto" alt="AskEmail"/>
  </a>
</div>

<p align="center">
    <em>Your Remote Coworker, One Email Away. Forward boring emails, get smart responses</em>
</p>

# AskEmail

AskEmail is an open-source AI email assistant that processes emails and provides intelligent responses using Google's Gemini model. Deploy it on your own Cloudflare infrastructure or use our hosted service.

## Quick Links

- 🌐 **Website**: [askemail.com](https://askemail.com)
- ✉️ **Demo**: [anything@askemail.com](mailto:anything@askemail.com)
- 💻 **Source Code**: [github.com/G4brym/askemail](https://github.com/G4brym/askemail)

## Overview

AskEmail is a serverless AI assistant that processes emails and provides intelligent responses. It leverages Cloudflare Workers, Google's Gemini model, and vector databases to provide a powerful, privacy-focused email assistant that you can self-host.

## Key Features

- **📧 Email Processing**
	- Process and analyze email content and attachments
	- Summarize long email threads
	- File analysis (up to 0.5MB)
	- Smart context-aware responses

- **🧠 Memory Management**
	- Optional conversation memory using vector database
	- Context-aware responses based on previous interactions
	- Explicit memory management (store/forget)

- **🛡️ Security & Privacy**
	- Whitelist-based email authorization
	- No data storage unless explicitly requested
	- Optional AWS SES integration for broader email support
	- No registration or login required
	- Fully self-hostable

## Architecture

```mermaid
graph TD
    A[Email Received] --> B[Email Worker]
    B --> C[Gemini 1.5 Flash]
    C --> D{Memory Operation?}
    D -->|Store| E[Insert into Cloudflare Vectorize]
    D -->|Read| F[Query Cloudflare Vectorize]
    E --> G[Store in D1]
    F --> H[Retrieve from D1]
    H --> C
    C --> I[Parse Response]
    I --> J[Send Email]
    J -->|Option 1| K[Email Workers]
    J -->|Option 2| L[AWS SES]
```

## Installation Guide

### Prerequisites
- Node.js and npm installed
- Cloudflare account
- Google AI Studio API key
- Domain with Cloudflare email routing

### Step 1: Initial Setup
```bash
# Install dependencies
npm install

# Login to Cloudflare
npx wrangler login

# Create vector database
npx wrangler vectorize create askemail-index --dimensions=1024 --metric=cosine

# Create D1 database
npx wrangler d1 create askemail-db

# Apply database migrations
npx wrangler d1 migrations apply DB --remote
```

### Step 2: Configuration
1. Update `wrangler.toml`:
	- Set `allowed_destination_addresses`
	- Configure database ID from D1 creation
2. Update `FROM_ADDRESS` in `src/configs.ts`

### Step 3: Deployment
```bash
# Deploy the worker
npx wrangler deploy

# Set Google AI API key
npx wrangler secret put GOOGLE_AI_KEY
```

### Step 4: Email Routing
Configure your domain's email routing in Cloudflare Dashboard:
1. Navigate to Email > Email Routing
2. Create a new routing rule pointing to your worker
3. Test the setup by sending an email from your allowed list

## Usage

The service supports two deployment models:

1. **Hosted Service** (Free Tier)
	- Send emails to [anything@askemail.com](mailto:anything@askemail.com)
	- Limited to 10 emails per day
	- All features included

2. **Self-Hosted** (Cloudflare Workers Free Plan)
	- Deploy on your own infrastructure
	- Configure custom email addresses
	- Set custom rate limits
	- Full control over data and privacy

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

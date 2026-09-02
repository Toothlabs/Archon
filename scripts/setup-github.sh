#!/bin/bash
# GitHub Integration Setup Script for Archon
# This script helps configure GitHub CLI and PAT token for Agent Work Orders

set -e

ARCHON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ARCHON_DIR/.env"

echo "=== Archon GitHub Integration Setup ==="
echo ""

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    echo "ERROR: GitHub CLI (gh) is not installed."
    echo "Install it with: sudo apt install gh"
    exit 1
fi

echo "✓ GitHub CLI found: $(gh --version | head -1)"
echo ""

# Check current auth status
echo "Checking GitHub authentication status..."
if gh auth status &> /dev/null; then
    echo "✓ Already authenticated with GitHub"
    GH_USER=$(gh api user -q '.login' 2>/dev/null || echo "unknown")
    echo "  Logged in as: $GH_USER"
else
    echo "✗ Not authenticated with GitHub"
    echo ""
    echo "Choose authentication method:"
    echo "  1. Browser-based login (recommended for personal use)"
    echo "  2. Personal Access Token (recommended for automation)"
    echo ""
    read -p "Enter choice (1 or 2): " AUTH_CHOICE

    case $AUTH_CHOICE in
        1)
            echo ""
            echo "Starting browser-based authentication..."
            gh auth login --hostname github.com --git-protocol https --web
            ;;
        2)
            echo ""
            echo "To create a Personal Access Token:"
            echo "  1. Go to: https://github.com/settings/tokens"
            echo "  2. Click 'Generate new token (classic)'"
            echo "  3. Select scopes: repo, workflow, read:org, read:user, user:email"
            echo "  4. Copy the generated token"
            echo ""
            read -sp "Paste your GitHub Personal Access Token: " GH_TOKEN
            echo ""

            if [ -n "$GH_TOKEN" ]; then
                echo "$GH_TOKEN" | gh auth login --with-token

                # Also update .env file
                if [ -f "$ENV_FILE" ]; then
                    if grep -q "^GITHUB_PAT_TOKEN=" "$ENV_FILE"; then
                        sed -i "s|^GITHUB_PAT_TOKEN=.*|GITHUB_PAT_TOKEN=$GH_TOKEN|" "$ENV_FILE"
                    else
                        echo "GITHUB_PAT_TOKEN=$GH_TOKEN" >> "$ENV_FILE"
                    fi
                    echo "✓ Updated GITHUB_PAT_TOKEN in .env"
                fi
            fi
            ;;
        *)
            echo "Invalid choice. Exiting."
            exit 1
            ;;
    esac
fi

echo ""

# Verify authentication
if gh auth status &> /dev/null; then
    echo "=== Authentication Successful ==="
    gh auth status
    echo ""

    # Get token for .env if needed
    GH_TOKEN_VALUE=$(gh auth token 2>/dev/null || echo "")

    if [ -n "$GH_TOKEN_VALUE" ] && [ -f "$ENV_FILE" ]; then
        CURRENT_TOKEN=$(grep "^GITHUB_PAT_TOKEN=" "$ENV_FILE" | cut -d'=' -f2)
        if [ -z "$CURRENT_TOKEN" ] || [ "$CURRENT_TOKEN" != "$GH_TOKEN_VALUE" ]; then
            sed -i "s|^GITHUB_PAT_TOKEN=.*|GITHUB_PAT_TOKEN=$GH_TOKEN_VALUE|" "$ENV_FILE"
            echo "✓ Synced token to GITHUB_PAT_TOKEN in .env"
        fi
    fi

    echo ""
    echo "=== Testing Repository Access ==="

    # Test API access
    if gh api user &> /dev/null; then
        echo "✓ API access working"
    else
        echo "✗ API access failed"
    fi

    echo ""
    echo "=== Setup Complete ==="
    echo ""
    echo "To start Agent Work Orders with GitHub integration:"
    echo "  docker compose --profile work-orders up -d"
    echo ""
else
    echo "ERROR: Authentication failed"
    exit 1
fi

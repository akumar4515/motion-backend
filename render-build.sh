#!/bin/bash
# Install dependencies
npm ci

# Install Chromium system-wide
apt-get update
apt-get install -y chromium

# Verify Chromium installation
if [ -f "/usr/bin/chromium-browser" ]; then
  echo "Chromium installed successfully at /usr/bin/chromium-browser"
else
  echo "Failed to install Chromium"
  exit 1
fi#!/bin/bash
# Install dependencies
echo "Installing Node.js dependencies..."
npm ci

#!/bin/bash

set -e

echo "🛠️ Updating package list..."
apt-get update -y

echo "🌐 Installing Chromium..."
apt-get install -y chromium-browser || apt-get install -y chromium

echo "🔍 Locating Chromium binary..."
CHROMIUM_PATH=$(command -v chromium-browser || command -v chromium || echo "not found")

if [ "$CHROMIUM_PATH" != "not found" ]; then
  echo "✅ Chromium found at: $CHROMIUM_PATH"
else
  echo "❌ Chromium installation failed or binary not found"
  echo "📦 Listing available chromium packages..."
  apt-cache search chromium
  exit 1
fi

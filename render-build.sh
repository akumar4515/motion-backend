#!/bin/bash
# Install dependencies
npm ci

# Update package list and install Chromium
apt-get update
apt-get install -y chromium-browser

# Find and log the Chromium binary location
echo "Locating Chromium binary..."
CHROMIUM_PATH=$(which chromium-browser || which chromium || echo "not found")
if [ "$CHROMIUM_PATH" != "not found" ]; then
  echo "Chromium found at: $CHROMIUM_PATH"
else
  echo "Chromium installation failed or binary not found"
  exit 1
fi
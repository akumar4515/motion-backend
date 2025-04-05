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
fi
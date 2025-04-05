#!/bin/bash
# Install Node.js dependencies
echo "Installing Node.js dependencies..."
npm ci

# Update package list and install Chromium with required dependencies
echo "Updating package list..."
apt-get update
echo "Installing chromium and dependencies..."
apt-get install -y \
  chromium \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxi6 \
  libxtst6 \
  libnss3 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libxkbcommon0 \
  libxrandr2 \
  libgbm1 \
  libasound2

# Find and log the Chromium binary location
echo "Locating Chromium binary..."
CHROMIUM_PATH=$(which chromium || which chromium-browser || echo "not found")
if [ "$CHROMIUM_PATH" != "not found" ]; then
  echo "Chromium found at: $CHROMIUM_PATH"
  echo "CHROMIUM_PATH=$CHROMIUM_PATH" >> $RENDER_ENV_FILE
else
  echo "Chromium installation failed or binary not found"
  echo "Listing available chromium packages..."
  apt-cache search chromium
  exit 1
fi
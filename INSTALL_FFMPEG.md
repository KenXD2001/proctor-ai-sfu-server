# Installing FFmpeg on Ubuntu Server

## Issue: Package Repository 404 Errors

If you're seeing 404 errors when trying to install FFmpeg, the package repositories may be out of sync or the mirror is having issues.

## Solution 1: Update Repositories and Retry

```bash
# Update package lists
sudo apt-get update

# Clean package cache
sudo apt-get clean

# Try installing FFmpeg again
sudo apt-get install -y ffmpeg
```

## Solution 2: Use Snap (Recommended if apt fails)

Snap is often more reliable for FFmpeg installation:

```bash
# Install FFmpeg via snap
sudo snap install ffmpeg

# Verify installation
ffmpeg -version

# Note: You may need to use the full path if snap binaries aren't in PATH
# Check the path:
snap list ffmpeg
which ffmpeg
```

If snap's ffmpeg isn't in your PATH, you can create a symlink:

```bash
# Find snap ffmpeg location
snap info ffmpeg

# Usually located at /snap/bin/ffmpeg
# Create symlink to /usr/local/bin (if needed)
sudo ln -s /snap/bin/ffmpeg /usr/local/bin/ffmpeg
```

## Solution 3: Fix Repository Sources

If the DigitalOcean mirror is having issues, switch to main Ubuntu repositories:

```bash
# Backup current sources
sudo cp /etc/apt/sources.list /etc/apt/sources.list.backup

# Edit sources.list to use main Ubuntu repositories
sudo nano /etc/apt/sources.list

# Replace DigitalOcean mirrors with main Ubuntu repositories:
# Change lines like:
#   deb http://mirrors.digitalocean.com/ubuntu/ oracular main
# To:
#   deb http://archive.ubuntu.com/ubuntu/ oracular main
#   deb http://archive.ubuntu.com/ubuntu/ oracular-updates main
#   deb http://security.ubuntu.com/ubuntu/ oracular-security main

# Or use sed to do it automatically:
sudo sed -i 's|http://mirrors.digitalocean.com/ubuntu|http://archive.ubuntu.com/ubuntu|g' /etc/apt/sources.list

# Update package lists
sudo apt-get update

# Try installing FFmpeg
sudo apt-get install -y ffmpeg
```

## Solution 4: Use --fix-missing Flag

```bash
# Try with fix-missing flag
sudo apt-get update --fix-missing
sudo apt-get install -y ffmpeg --fix-missing
```

## Solution 5: Install from Source (Advanced)

If all else fails, compile from source:

```bash
# Install build dependencies
sudo apt-get update
sudo apt-get install -y \
  build-essential \
  yasm \
  cmake \
  libtool \
  libc6 \
  libc6-dev \
  unzip \
  wget \
  x264 \
  libx264-dev

# Download FFmpeg source
cd /tmp
wget https://ffmpeg.org/releases/ffmpeg-7.0.tar.bz2
tar -xjf ffmpeg-7.0.tar.bz2
cd ffmpeg-7.0

# Configure and build
./configure --enable-gpl --enable-libx264
make -j$(nproc)
sudo make install

# Verify
ffmpeg -version
```

## Quick Fix (Recommended)

For the fastest solution, use snap:

```bash
sudo snap install ffmpeg
ffmpeg -version
```

If snap isn't installed:

```bash
# Install snapd first
sudo apt-get update
sudo apt-get install -y snapd
sudo systemctl enable --now snapd

# Then install FFmpeg
sudo snap install ffmpeg
```

## Verify Installation

After installation, verify FFmpeg works:

```bash
ffmpeg -version
```

You should see output like:
```
ffmpeg version 7.0.2 Copyright (c) 2000-2024 the FFmpeg developers
...
```

## Restart SFU Server

After installing FFmpeg, restart your SFU server:

```bash
pm2 restart proctor-sfu-server
pm2 logs proctor-sfu-server
```

## Troubleshooting

If FFmpeg is installed but still not found:

1. **Check PATH:**
```bash
which ffmpeg
echo $PATH
```

2. **Check if it's in a non-standard location:**
```bash
find /usr -name ffmpeg 2>/dev/null
find /snap -name ffmpeg 2>/dev/null
```

3. **Add to PATH if needed:**
```bash
# Add to ~/.bashrc or /etc/environment
export PATH=$PATH:/snap/bin
```

